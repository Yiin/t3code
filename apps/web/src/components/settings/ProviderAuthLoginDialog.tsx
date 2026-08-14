"use client";

import { CheckIcon, CopyIcon, ExternalLinkIcon, LoaderIcon, SendIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { EnvironmentId, ProviderAuthLoginStartResult } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { reduceProviderAuthRunState } from "./providerAccounts.logic";

interface ProviderAuthLoginDialogProps {
  readonly environmentId: EnvironmentId;
  readonly displayName: string;
  readonly start: ProviderAuthLoginStartResult;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onOpenChangeComplete: (open: boolean) => void;
}

const statusPresentation = {
  idle: { label: "Starting", variant: "secondary" },
  running: { label: "Waiting", variant: "info" },
  succeeded: { label: "Signed in", variant: "success" },
  failed: { label: "Failed", variant: "error" },
  cancelled: { label: "Cancelled", variant: "secondary" },
} as const;

export function ProviderAuthLoginDialog(props: ProviderAuthLoginDialogProps) {
  const [state, setState] = useState(props.start.state);
  const stateRef = useRef(state);
  stateRef.current = state;
  const mountedRef = useRef(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [isSending, setIsSending] = useState(false);
  const cancelLogin = useAtomCommand(serverEnvironment.providerAuthLoginCancel, {
    reportFailure: false,
  });
  const respondLogin = useAtomCommand(serverEnvironment.providerAuthLoginRespond, {
    reportFailure: false,
  });
  // This component mounts only after loginStart returns a terminal id. The
  // subscription therefore never opens with an empty or guessed id.
  const status = useEnvironmentQuery(
    serverEnvironment.providerAuthLoginStatus({
      environmentId: props.environmentId,
      input: { terminalId: props.start.terminalId },
    }),
  );
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "provider authentication code",
    onCopy: () => {
      toastManager.add({ type: "success", title: "Authentication code copied" });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy authentication code",
          description: error.message,
        }),
      );
    },
  });

  useEffect(() => {
    const incoming = status.data;
    if (incoming) {
      stateRef.current = reduceProviderAuthRunState(stateRef.current, incoming);
      setState((current) => reduceProviderAuthRunState(current, incoming));
      if (incoming.status !== "running") setCancelError(null);
    }
  }, [status.data]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      queueMicrotask(() => {
        // React Strict Mode remounts effects during development. Wait one
        // microtask so that probe does not cancel a login that remains visible.
        if (mountedRef.current || stateRef.current.status !== "running") return;
        void cancelLogin({
          environmentId: props.environmentId,
          input: { terminalId: props.start.terminalId },
        });
      });
    };
  }, [cancelLogin, props.environmentId, props.start.terminalId]);

  const requestClose = async () => {
    if (state.status !== "running") {
      props.onOpenChange(false);
      return;
    }
    if (isCancelling) return;

    setIsCancelling(true);
    setCancelError(null);
    const result = await cancelLogin({
      environmentId: props.environmentId,
      input: { terminalId: props.start.terminalId },
    });
    setIsCancelling(false);
    if (result._tag === "Success") {
      stateRef.current = reduceProviderAuthRunState(stateRef.current, result.value.state);
      setState((current) => reduceProviderAuthRunState(current, result.value.state));
      props.onOpenChange(false);
      return;
    }
    const error = isAtomCommandInterrupted(result)
      ? new Error("The cancellation request was interrupted.")
      : squashAtomCommandFailure(result);
    const message = error instanceof Error ? error.message : "The cancellation request failed.";
    setCancelError(message);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not cancel sign-in",
        description: message,
      }),
    );
  };

  const submitInput = async () => {
    const data = inputValue.trim();
    if (data.length === 0 || isSending || state.status !== "running") return;
    setIsSending(true);
    const result = await respondLogin({
      environmentId: props.environmentId,
      input: { terminalId: props.start.terminalId, data },
    });
    setIsSending(false);
    if (result._tag === "Success") {
      // The value can be a one-time code; drop it from React state right away.
      setInputValue("");
      return;
    }
    const error = isAtomCommandInterrupted(result)
      ? new Error("The request was interrupted.")
      : squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not send the code",
        description: error instanceof Error ? error.message : "The request failed.",
      }),
    );
  };

  const presentation = statusPresentation[state.status];

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (open) props.onOpenChange(true);
        else void requestClose();
      }}
      onOpenChangeComplete={props.onOpenChangeComplete}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <div className="flex min-w-0 items-center gap-2 pr-8">
            <DialogTitle className="truncate">Sign in to {props.displayName}</DialogTitle>
            <Badge variant={presentation.variant} size="sm">
              {presentation.label}
            </Badge>
          </div>
          <DialogDescription>
            Finish the provider&apos;s browser or device flow. This window updates as the command
            runs.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel className="min-w-0 space-y-4">
          {state.verificationUrl ? (
            <div className="grid min-w-0 gap-1.5">
              <span className="text-xs font-medium text-foreground">Verification page</span>
              <a
                href={state.verificationUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-8 min-w-0 items-center gap-1.5 rounded-md text-sm text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
              >
                <span className="min-w-0 break-all">{state.verificationUrl}</span>
                <ExternalLinkIcon className="size-3.5 shrink-0" aria-hidden />
              </a>
            </div>
          ) : null}

          {state.userCode ? (
            <div className="grid min-w-0 gap-1.5">
              <span className="text-xs font-medium text-foreground">
                Device code — enter it on the verification page
              </span>
              <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border/70 bg-muted/35 p-2">
                <code className="min-w-0 flex-1 break-all px-1 font-mono text-sm font-semibold tracking-wide select-all">
                  {state.userCode}
                </code>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="min-h-7 shrink-0"
                  onClick={() => {
                    if (state.userCode) copyToClipboard(state.userCode, undefined);
                  }}
                  disabled={isCopied}
                >
                  {isCopied ? <CheckIcon /> : <CopyIcon />}
                  {isCopied ? "Copied" : "Copy"}
                </Button>
              </div>
            </div>
          ) : null}

          {state.status === "running" ? (
            <form
              className="grid min-w-0 gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                void submitInput();
              }}
            >
              <label
                htmlFor="provider-auth-login-input"
                className="text-xs font-medium text-foreground"
              >
                Send input to the command
              </label>
              <div className="flex min-w-0 items-center gap-2">
                <Input
                  id="provider-auth-login-input"
                  value={inputValue}
                  onChange={(event) => setInputValue(event.target.value)}
                  placeholder="Paste the code from your browser and press Enter"
                  autoComplete="off"
                  spellCheck={false}
                  className="min-w-0 flex-1 font-mono"
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="outline"
                  className="min-h-8 shrink-0"
                  disabled={inputValue.trim().length === 0 || isSending}
                >
                  {isSending ? <LoaderIcon className="animate-spin" /> : <SendIcon />}
                  Send
                </Button>
              </div>
            </form>
          ) : null}

          <div className="grid min-w-0 gap-1.5">
            <span className="text-xs font-medium text-foreground">Command output</span>
            <div className="max-w-full overflow-x-auto rounded-lg border border-border/70 bg-muted/35">
              <pre className="min-h-24 w-max min-w-full whitespace-pre p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
                {state.output || "Waiting for the provider command…"}
              </pre>
            </div>
          </div>

          <div className="min-h-5 text-xs text-muted-foreground" aria-live="polite">
            {cancelError ?? status.error ?? state.message ?? "Waiting for an update."}
          </div>
        </DialogPanel>

        <DialogFooter>
          {state.status === "running" ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => void requestClose()}
              disabled={isCancelling}
            >
              {isCancelling ? <LoaderIcon className="animate-spin" /> : null}
              {isCancelling ? "Cancelling" : "Cancel"}
            </Button>
          ) : (
            <Button type="button" onClick={() => void requestClose()}>
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
