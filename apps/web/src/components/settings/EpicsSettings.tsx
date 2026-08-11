import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_EPIC_ROLE_POLICY,
  EpicTierId,
  type EpicRolePolicy,
  type EpicTier,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { Link } from "@tanstack/react-router";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, SaveIcon, Trash2Icon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { primaryServerProvidersAtom } from "../../state/server";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import {
  addTierHop,
  assignRoleTier,
  buildEpicRolePolicyPatch,
  buildEpicRoleRows,
  createTier,
  deleteTier,
  isEpicRolePolicyDirty,
  moveTierHop,
  removeTierHop,
  renameTier,
  setTierHopSelection,
  setTierHopSkipAboveUtilization,
} from "./EpicsSettings.logic";

const UNASSIGNED_VALUE = "__unassigned__";

type DeleteTarget = { readonly kind: "tier" } | { readonly kind: "hop"; readonly index: number };

interface TierEditorProps {
  readonly tierId: EpicTierId;
  readonly tier: EpicTier;
  readonly policy: EpicRolePolicy;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReturnType<typeof getCustomModelOptionsByInstance>;
  readonly onPolicyChange: (policy: EpicRolePolicy) => void;
}

function TierEditor({
  tierId,
  tier,
  policy,
  instanceEntries,
  modelOptionsByInstance,
  onPolicyChange,
}: TierEditorProps) {
  const [renameInput, setRenameInput] = useState<string>(tierId);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const hopKeyPrefix = useId();
  const nextHopKeyNumber = useRef(tier.hops.length);
  const [hopKeys, setHopKeys] = useState(() =>
    tier.hops.map((_, index) => `${hopKeyPrefix}-${index}`),
  );
  const firstSelection = useMemo(() => {
    const entry = instanceEntries.find((candidate) => candidate.enabled);
    if (!entry) return null;
    const model =
      modelOptionsByInstance.get(entry.instanceId)?.[0]?.slug ??
      entry.models.find((candidate) => candidate.isDefault)?.slug ??
      entry.models[0]?.slug;
    return model ? createModelSelection(entry.instanceId, model) : null;
  }, [instanceEntries, modelOptionsByInstance]);

  useEffect(() => {
    setHopKeys((currentKeys) => {
      if (currentKeys.length === tier.hops.length) return currentKeys;
      if (currentKeys.length > tier.hops.length) return currentKeys.slice(0, tier.hops.length);
      const nextKeys = [...currentKeys];
      while (nextKeys.length < tier.hops.length) {
        nextKeys.push(`${hopKeyPrefix}-${nextHopKeyNumber.current++}`);
      }
      return nextKeys;
    });
  }, [hopKeyPrefix, tier.hops.length]);

  const handleRename = () => {
    const result = renameTier(policy, tierId, renameInput);
    if ("error" in result) {
      setRenameError(result.error);
      return;
    }
    setRenameError(null);
    onPolicyChange(result.policy);
  };

  const handleMoveHop = (index: number, direction: "up" | "down") => {
    const nextIndex = index + (direction === "up" ? -1 : 1);
    setHopKeys((currentKeys) => {
      if (nextIndex < 0 || nextIndex >= currentKeys.length) return currentKeys;
      const nextKeys = [...currentKeys];
      [nextKeys[index], nextKeys[nextIndex]] = [nextKeys[nextIndex]!, nextKeys[index]!];
      return nextKeys;
    });
    onPolicyChange(moveTierHop(policy, tierId, index, direction));
  };

  const handleRemoveHop = (index: number) => {
    setHopKeys((currentKeys) =>
      currentKeys.filter((_, candidateIndex) => candidateIndex !== index),
    );
    onPolicyChange(removeTierHop(policy, tierId, index));
  };

  const handleAddHop = () => {
    if (!firstSelection) return;
    setHopKeys((currentKeys) => [...currentKeys, `${hopKeyPrefix}-${nextHopKeyNumber.current++}`]);
    onPolicyChange(addTierHop(policy, tierId, { selection: firstSelection }));
  };
  const hopRows = tier.hops.map((hop, index) => ({
    hop,
    index,
    key: hopKeys[index] ?? `${hopKeyPrefix}-pending-${index}`,
  }));

  return (
    <>
      <SettingsRow
        title={tierId}
        description={`${tier.hops.length} ${tier.hops.length === 1 ? "hop" : "hops"} in fallback order.`}
        control={
          <Button
            size="xs"
            variant="destructive-outline"
            aria-label={`Delete tier ${tierId}`}
            onClick={() => setDeleteTarget({ kind: "tier" })}
          >
            <Trash2Icon />
            Delete
          </Button>
        }
      >
        <div className="space-y-3 pb-4 pt-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <label className="sr-only" htmlFor={`epic-tier-${tierId}-rename`}>
              New ID for tier {tierId}
            </label>
            <Input
              id={`epic-tier-${tierId}-rename`}
              value={renameInput}
              aria-invalid={renameError ? true : undefined}
              aria-describedby={renameError ? `epic-tier-${tierId}-rename-error` : undefined}
              onChange={(event) => {
                setRenameInput(event.target.value);
                setRenameError(null);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                handleRename();
              }}
              spellCheck={false}
            />
            <Button size="sm" variant="outline" onClick={handleRename}>
              <SaveIcon />
              Rename
            </Button>
          </div>
          {renameError ? (
            <p
              id={`epic-tier-${tierId}-rename-error`}
              className="text-xs text-destructive"
              role="alert"
            >
              {renameError}
            </p>
          ) : null}

          <div className="space-y-2">
            {hopRows.map(({ hop, index, key: hopKey }) => {
              const entry = instanceEntries.find(
                (candidate) => candidate.instanceId === hop.selection.instanceId,
              );
              const isMissing = entry === undefined;
              return (
                <div
                  key={hopKey}
                  className="min-w-0 overflow-hidden rounded-xl border border-border/70 bg-background/55 p-3"
                >
                  <div className="flex min-w-0 flex-col gap-3">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <Badge variant="secondary">Hop {index + 1}</Badge>
                      {isMissing ? (
                        <Badge
                          variant="warning"
                          className="max-w-full overflow-hidden text-ellipsis"
                          title={`Missing provider instance: ${hop.selection.instanceId}`}
                        >
                          Instance missing: {hop.selection.instanceId}
                        </Badge>
                      ) : null}
                    </div>
                    <div className="flex min-w-0 flex-col gap-2 lg:flex-row lg:items-center">
                      <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:flex-row">
                        <ProviderModelPicker
                          activeInstanceId={hop.selection.instanceId}
                          model={hop.selection.model}
                          lockedProvider={null}
                          instanceEntries={instanceEntries}
                          modelOptionsByInstance={modelOptionsByInstance}
                          triggerVariant="outline"
                          triggerClassName="w-full min-w-0 max-w-full shrink text-foreground/90 hover:text-foreground sm:flex-1"
                          onInstanceModelChange={(instanceId, model) =>
                            onPolicyChange(
                              setTierHopSelection(
                                policy,
                                tierId,
                                index,
                                createModelSelection(instanceId, model),
                              ),
                            )
                          }
                        />
                        {entry ? (
                          <TraitsPicker
                            provider={entry.driverKind}
                            models={entry.models}
                            model={hop.selection.model}
                            prompt=""
                            onPromptChange={() => {}}
                            modelOptions={hop.selection.options}
                            allowPromptInjectedEffort={false}
                            triggerVariant="outline"
                            triggerClassName="w-full min-w-0 max-w-full shrink text-foreground/90 hover:text-foreground sm:w-auto sm:max-w-44 sm:shrink-0"
                            onModelOptionsChange={(nextOptions) =>
                              onPolicyChange(
                                setTierHopSelection(
                                  policy,
                                  tierId,
                                  index,
                                  createModelSelection(
                                    hop.selection.instanceId,
                                    hop.selection.model,
                                    nextOptions,
                                  ),
                                ),
                              )
                            }
                          />
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center self-end gap-1.5 pointer-coarse:gap-2 lg:self-auto">
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          className="pointer-coarse:size-11"
                          disabled={index === 0}
                          aria-label={`Move hop ${index + 1} up`}
                          onClick={() => handleMoveHop(index, "up")}
                        >
                          <ArrowUpIcon />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          className="pointer-coarse:size-11"
                          disabled={index === tier.hops.length - 1}
                          aria-label={`Move hop ${index + 1} down`}
                          onClick={() => handleMoveHop(index, "down")}
                        >
                          <ArrowDownIcon />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          className="pointer-coarse:size-11"
                          aria-label={`Remove hop ${index + 1}`}
                          onClick={() => setDeleteTarget({ kind: "hop", index })}
                        >
                          <Trash2Icon />
                        </Button>
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <label
                      className="text-xs text-muted-foreground"
                      htmlFor={`epic-tier-${tierId}-hop-${index}-threshold`}
                    >
                      Skip above utilization
                    </label>
                    <Input
                      id={`epic-tier-${tierId}-hop-${index}-threshold`}
                      className="w-24"
                      type="number"
                      min={0}
                      max={100}
                      step={1}
                      placeholder="None"
                      value={hop.skipAboveUtilization ?? ""}
                      aria-label={`Skip hop ${index + 1} above utilization percent`}
                      onChange={(event) => {
                        const raw = event.target.value;
                        const threshold = raw === "" ? undefined : Number(raw);
                        if (
                          threshold !== undefined &&
                          (!Number.isInteger(threshold) || threshold < 0 || threshold > 100)
                        ) {
                          return;
                        }
                        onPolicyChange(
                          setTierHopSkipAboveUtilization(policy, tierId, index, threshold),
                        );
                      }}
                    />
                    <span className="text-xs text-muted-foreground">%</span>
                  </div>
                </div>
              );
            })}
          </div>

          {tier.hops.length === 0 ? (
            <p className="rounded-xl border border-dashed p-4 text-center text-xs text-muted-foreground">
              This tier has no hops. Add one to start its fallback chain.
            </p>
          ) : null}

          {firstSelection === null ? (
            <p
              id={`epic-tier-${tierId}-provider-guidance`}
              className="text-xs text-muted-foreground"
            >
              No enabled provider can seed a hop. Configure or enable one in{" "}
              <Link
                className="underline underline-offset-2 hover:text-foreground"
                to="/settings/providers"
              >
                Settings &gt; Providers
              </Link>
              .
            </p>
          ) : null}

          <Button
            size="sm"
            variant="outline"
            disabled={firstSelection === null}
            aria-describedby={
              firstSelection === null ? `epic-tier-${tierId}-provider-guidance` : undefined
            }
            onClick={handleAddHop}
          >
            <PlusIcon />
            Add hop
          </Button>
        </div>
      </SettingsRow>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteTarget?.kind === "hop"
                ? `Delete hop ${deleteTarget.index + 1}?`
                : `Delete tier "${tierId}"?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.kind === "hop"
                ? "The remaining hops keep their current fallback order."
                : "This also removes the tier from every assigned epic role."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleteTarget?.kind === "hop") handleRemoveHop(deleteTarget.index);
                else if (deleteTarget?.kind === "tier") {
                  onPolicyChange(deleteTier(policy, tierId));
                }
                setDeleteTarget(null);
              }}
            >
              {deleteTarget?.kind === "hop" ? "Delete hop" : "Delete tier"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

export function EpicsSettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const [newTierInput, setNewTierInput] = useState("");
  const [newTierError, setNewTierError] = useState<string | null>(null);
  const policy = settings.epicRolePolicy;
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
  );
  const modelOptionsByInstance = getCustomModelOptionsByInstance(settings, serverProviders);
  const roleRows = buildEpicRoleRows({ policy, entries: instanceEntries });
  const tierIds = Object.keys(policy.tiers) as EpicTierId[];

  const updatePolicy = (nextPolicy: EpicRolePolicy) => {
    updateSettings(buildEpicRolePolicyPatch(nextPolicy));
  };

  const handleCreateTier = () => {
    const result = createTier(policy, newTierInput);
    if ("error" in result) {
      setNewTierError(result.error);
      return;
    }
    setNewTierInput("");
    setNewTierError(null);
    updatePolicy(result.policy);
  };

  return (
    <SettingsPageContainer>
      <SettingsSection title="Roles">
        {roleRows.map((row) => (
          <SettingsRow
            key={row.roleId}
            title={row.label}
            description={row.description}
            status={
              row.tierId ? (
                <span>
                  {row.hopCount} {row.hopCount === 1 ? "hop" : "hops"}
                  {row.unresolvedHops.length > 0
                    ? `, ${row.unresolvedHops.length} missing ${row.unresolvedHops.length === 1 ? "instance" : "instances"}`
                    : ""}
                </span>
              ) : (
                "Uses the run's pinned or default model."
              )
            }
            control={
              <Select
                value={row.tierId ?? UNASSIGNED_VALUE}
                onValueChange={(value) => {
                  if (!value) return;
                  updatePolicy(
                    assignRoleTier(
                      policy,
                      row.roleId,
                      value === UNASSIGNED_VALUE ? null : EpicTierId.make(value),
                    ),
                  );
                }}
              >
                <SelectTrigger className="w-full sm:w-48" aria-label={`Tier for ${row.label}`}>
                  <SelectValue>{row.tierId ?? "Unassigned"}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value={UNASSIGNED_VALUE}>Unassigned</SelectItem>
                  {tierIds.map((tierId) => (
                    <SelectItem key={tierId} value={tierId}>
                      {tierId}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        ))}
      </SettingsSection>

      <SettingsSection
        title="Tiers"
        headerAction={
          isEpicRolePolicyDirty(policy) ? (
            <SettingResetButton
              label="epic role policy"
              onClick={() => updatePolicy(DEFAULT_EPIC_ROLE_POLICY)}
            />
          ) : null
        }
      >
        <SettingsRow
          title="Add tier"
          description="Create a named fallback chain for one or more epic roles."
        >
          <div className="space-y-2 pb-4 pt-3">
            <div className="flex flex-col gap-2 sm:flex-row">
              <label className="sr-only" htmlFor="epic-new-tier-id">
                New tier ID
              </label>
              <Input
                id="epic-new-tier-id"
                value={newTierInput}
                placeholder="high-capability"
                aria-invalid={newTierError ? true : undefined}
                aria-describedby={newTierError ? "epic-new-tier-error" : undefined}
                onChange={(event) => {
                  setNewTierInput(event.target.value);
                  setNewTierError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  handleCreateTier();
                }}
                spellCheck={false}
              />
              <Button size="sm" variant="outline" onClick={handleCreateTier}>
                <PlusIcon />
                Add tier
              </Button>
            </div>
            {newTierError ? (
              <p id="epic-new-tier-error" className="text-xs text-destructive" role="alert">
                {newTierError}
              </p>
            ) : null}
          </div>
        </SettingsRow>

        {tierIds.length === 0 ? (
          <SettingsRow
            title="No tiers configured"
            description="Add a tier, then assign it to an epic role."
          />
        ) : null}

        {tierIds.map((tierId) => (
          <TierEditor
            key={tierId}
            tierId={tierId}
            tier={policy.tiers[tierId]!}
            policy={policy}
            instanceEntries={instanceEntries}
            modelOptionsByInstance={modelOptionsByInstance}
            onPolicyChange={updatePolicy}
          />
        ))}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
