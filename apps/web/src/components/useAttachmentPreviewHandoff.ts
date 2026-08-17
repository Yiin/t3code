import { useCallback, useEffect, useRef, useState } from "react";
import type { MessageId } from "@t3tools/contracts";
import type { ChatMessage } from "../types";
import {
  decideAttachmentPreviewPromotions,
  revokeBlobPreviewUrl,
  type AttachmentPreviewHandoff,
} from "./ChatView.logic";

export function useAttachmentPreviewHandoff(serverMessages: ReadonlyArray<ChatMessage>): {
  handoffs: AttachmentPreviewHandoff;
  handoffAttachmentPreviews: (messageId: MessageId, previewUrls: string[]) => void;
} {
  const [handoffs, setHandoffs] = useState<Record<string, string[]>>({});
  const handoffsRef = useRef<AttachmentPreviewHandoff>({});
  const promotionInFlightRef = useRef<Record<string, true>>({});

  const clearHandoff = useCallback((messageId: string, previewUrls?: ReadonlyArray<string>) => {
    delete promotionInFlightRef.current[messageId];
    const currentPreviewUrls = previewUrls ?? handoffsRef.current[messageId] ?? [];
    setHandoffs((existing) => {
      if (!(messageId in existing)) return existing;
      const next = { ...existing };
      delete next[messageId];
      handoffsRef.current = next;
      return next;
    });
    for (const previewUrl of currentPreviewUrls) revokeBlobPreviewUrl(previewUrl);
  }, []);

  const clearAllHandoffs = useCallback(() => {
    promotionInFlightRef.current = {};
    for (const previewUrls of Object.values(handoffsRef.current)) {
      for (const previewUrl of previewUrls) revokeBlobPreviewUrl(previewUrl);
    }
    handoffsRef.current = {};
    setHandoffs({});
  }, []);

  useEffect(() => {
    handoffsRef.current = handoffs;
  }, [handoffs]);

  useEffect(() => {
    if (typeof Image === "undefined" || serverMessages.length === 0) return;
    const cleanups: Array<() => void> = [];
    for (const promotion of decideAttachmentPreviewPromotions(handoffs, serverMessages)) {
      if (promotionInFlightRef.current[promotion.messageId]) continue;
      promotionInFlightRef.current[promotion.messageId] = true;
      let cancelled = false;
      const imageInstances: HTMLImageElement[] = [];
      const preload = Promise.all(
        promotion.previewUrls.map(
          (previewUrl) =>
            new Promise<void>((resolve, reject) => {
              const image = new Image();
              imageInstances.push(image);
              image.addEventListener("load", () => resolve(), { once: true });
              image.addEventListener(
                "error",
                () =>
                  reject(new Error(`Failed to load server preview for ${promotion.messageId}.`)),
                { once: true },
              );
              image.src = previewUrl;
            }),
        ),
      );
      void preload
        .then(() => {
          if (!cancelled) clearHandoff(promotion.messageId, promotion.previewUrls);
        })
        .catch(() => {
          if (!cancelled) delete promotionInFlightRef.current[promotion.messageId];
        });
      cleanups.push(() => {
        cancelled = true;
        delete promotionInFlightRef.current[promotion.messageId];
        for (const image of imageInstances) image.src = "";
      });
    }
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [clearHandoff, handoffs, serverMessages]);

  useEffect(() => clearAllHandoffs, [clearAllHandoffs]);

  const handoffAttachmentPreviews = useCallback((messageId: MessageId, previewUrls: string[]) => {
    if (previewUrls.length === 0) return;
    const previousPreviewUrls = handoffsRef.current[messageId] ?? [];
    const nextPreviewUrlSet = new Set(previewUrls);
    for (const previewUrl of previousPreviewUrls) {
      if (!nextPreviewUrlSet.has(previewUrl)) revokeBlobPreviewUrl(previewUrl);
    }
    setHandoffs((existing) => {
      const next = { ...existing, [messageId]: previewUrls };
      handoffsRef.current = next;
      return next;
    });
  }, []);

  return { handoffs, handoffAttachmentPreviews };
}
