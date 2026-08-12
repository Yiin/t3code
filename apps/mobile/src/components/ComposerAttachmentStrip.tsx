import { SymbolView } from "../components/AppSymbol";
import { Image, Pressable, ScrollView, View } from "react-native";
import { AppText as Text } from "./AppText";
import { useThemeColor } from "../lib/useThemeColor";

import type { DraftComposerAttachment } from "../lib/composerAttachments";

export interface ComposerAttachmentStripProps {
  /** Attachments to display. */
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  /** Called when the user taps the remove button on an attachment. */
  readonly onRemove: (attachmentId: string) => void;
  /** Called when the user taps an image thumbnail to preview it. */
  readonly onPressImage?: (previewUri: string) => void;
  /** Thumbnail size in points.  Defaults to 72. */
  readonly imageSize?: number;
  /** Border radius of each thumbnail.  Defaults to 16. */
  readonly imageBorderRadius?: number;
  /** Whether the remove button should sit in its own gutter instead of overlapping the image. */
  readonly removeButtonPlacement?: "overlay" | "gutter";
}

/** Uppercase extension for a file chip, empty when the name carries none. */
export function attachmentExtensionLabel(name: string): string {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === name.length - 1) return "";
  const extension = name.slice(dotIndex + 1);
  return /^[a-z0-9]{1,8}$/i.test(extension) ? extension.toUpperCase() : "";
}

/**
 * A horizontally-scrollable strip of attachment thumbnails with remove
 * buttons.  Used by both the thread composer and the new-task draft screen.
 * An image shows its thumbnail; a file shows an icon and its extension.
 */
export function ComposerAttachmentStrip(props: ComposerAttachmentStripProps) {
  const subtleBg = useThemeColor("--color-subtle");
  const iconColor = useThemeColor("--color-icon");
  const size = props.imageSize ?? 72;
  const radius = props.imageBorderRadius ?? 16;
  const removeButtonPlacement = props.removeButtonPlacement ?? "overlay";
  const removeButtonGutter = removeButtonPlacement === "gutter" ? 10 : 0;

  if (props.attachments.length === 0) {
    return null;
  }

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="always"
      className="grow-0"
    >
      <View className="flex-row gap-2.5">
        {props.attachments.map((attachment) => (
          <View
            key={attachment.id}
            className="relative"
            style={{
              paddingTop: removeButtonGutter,
              paddingRight: removeButtonGutter,
            }}
          >
            {attachment.type === "image" ? (
              <Pressable
                onPress={
                  props.onPressImage ? () => props.onPressImage!(attachment.previewUri) : undefined
                }
              >
                <Image
                  source={{ uri: attachment.previewUri }}
                  style={{
                    width: size,
                    height: size,
                    borderRadius: radius,
                    backgroundColor: subtleBg,
                  }}
                  resizeMode="cover"
                />
              </Pressable>
            ) : (
              <View
                accessibilityLabel={attachment.name}
                className="items-center justify-center gap-1 px-1.5"
                style={{
                  width: size,
                  height: size,
                  borderRadius: radius,
                  backgroundColor: subtleBg,
                }}
              >
                <SymbolView name="doc.text" size={20} tintColor={iconColor} type="monochrome" />
                <Text
                  className="text-3xs font-t3-medium text-foreground-muted"
                  numberOfLines={1}
                  ellipsizeMode="middle"
                >
                  {attachmentExtensionLabel(attachment.name) || attachment.name}
                </Text>
              </View>
            )}
            <Pressable
              className="absolute h-[22px] w-[22px] items-center justify-center rounded-[11px] bg-black/55"
              style={{
                top: removeButtonPlacement === "gutter" ? 0 : 4,
                right: removeButtonPlacement === "gutter" ? 0 : 4,
              }}
              hitSlop={6}
              onPress={() => props.onRemove(attachment.id)}
            >
              <SymbolView
                name="xmark"
                size={9}
                tintColor="#ffffff"
                type="monochrome"
                weight="bold"
              />
            </Pressable>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}
