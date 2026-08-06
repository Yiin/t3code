import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LayoutAnimation, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import {
  deriveSubagentInspectorGroups,
  type SubagentInspectorGroup,
} from "../../lib/threadActivity";
import { useFontFamily } from "../../lib/useFontFamily";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  hasNativeSelectableMarkdownText,
  SelectableMarkdownText,
  type NativeMarkdownTextStyle,
} from "../../native/SelectableMarkdownText";
import { useSelectedThreadDetail } from "../../state/use-thread-detail";
import { useThreadSelection } from "../../state/use-thread-selection";
import { ThreadWorkLog } from "./thread-work-log";
import { sortGroupsForInspector, statusLabel, toolCountLabel } from "./threadSubagentsPresentation";

type ThreadSubagentsSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

const DISCLOSURE_LAYOUT_ANIMATION = {
  duration: 180,
  create: {
    type: LayoutAnimation.Types.easeInEaseOut,
    property: LayoutAnimation.Properties.opacity,
  },
  update: { type: LayoutAnimation.Types.easeInEaseOut },
  delete: {
    type: LayoutAnimation.Types.easeInEaseOut,
    property: LayoutAnimation.Properties.opacity,
  },
} as const;

function capitalizeName(name: string): string {
  return name.length === 0 ? name : name.charAt(0).toUpperCase() + name.slice(1);
}

function statusIcon(status: SubagentInspectorGroup["status"]): AppSymbolName | null {
  switch (status) {
    case "running":
      return null;
    case "completed":
      return { ios: "checkmark", android: "check" };
    case "failed":
      return { ios: "xmark", android: "close" };
    case "stopped":
      return { ios: "minus", android: "remove" };
  }
}

function SubagentStatus(props: {
  readonly group: SubagentInspectorGroup;
  readonly iconColor: import("react-native").ColorValue;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (props.group.status !== "running") return;
    const intervalId = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(intervalId);
  }, [props.group.status, props.group.startedAt]);

  const icon = statusIcon(props.group.status);
  return (
    <View className="flex-row items-center gap-1.5 rounded-full bg-subtle px-2.5 py-1">
      {props.group.status === "running" ? (
        <View className="flex-row items-center gap-px">
          <View className="size-1 rounded-full bg-foreground-muted opacity-80" />
          <View className="size-1 rounded-full bg-foreground-muted opacity-60" />
          <View className="size-1 rounded-full bg-foreground-muted opacity-40" />
        </View>
      ) : icon ? (
        <SymbolView name={icon} size={11} tintColor={props.iconColor} type="monochrome" />
      ) : null}
      <Text className="text-2xs font-t3-medium tabular-nums text-foreground-muted">
        {statusLabel(props.group, now)}
      </Text>
    </View>
  );
}

function PromptDisclosure(props: {
  readonly expanded: boolean;
  readonly iconColor: import("react-native").ColorValue;
  readonly prompt: string;
  readonly onToggle: () => void;
}) {
  return (
    <View className="gap-1">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Subagent prompt"
        accessibilityState={{ expanded: props.expanded }}
        className="min-h-8 flex-row items-center justify-between rounded-md py-1"
        onPress={() => {
          LayoutAnimation.configureNext(DISCLOSURE_LAYOUT_ANIMATION);
          void Haptics.selectionAsync();
          props.onToggle();
        }}
      >
        <Text className="text-xs font-t3-bold text-foreground-muted">Prompt</Text>
        <SymbolView
          name={
            props.expanded
              ? { ios: "chevron.up", android: "keyboard_arrow_up" }
              : { ios: "chevron.down", android: "keyboard_arrow_down" }
          }
          size={12}
          tintColor={props.iconColor}
          type="monochrome"
        />
      </Pressable>
      {props.expanded ? (
        <ScrollView
          nestedScrollEnabled
          showsVerticalScrollIndicator
          className="max-h-52 rounded-xl bg-subtle px-3 py-2.5"
        >
          <Text selectable className="text-xs leading-5 text-foreground">
            {props.prompt}
          </Text>
        </ScrollView>
      ) : null}
    </View>
  );
}

function ResultText(props: {
  readonly markdownStyle: NativeMarkdownTextStyle;
  readonly result: string;
}) {
  return (
    <View className="gap-1.5 border-t border-border pt-3">
      <Text className="text-xs font-t3-bold text-foreground-muted">Result</Text>
      {hasNativeSelectableMarkdownText() ? (
        <SelectableMarkdownText markdown={props.result} textStyle={props.markdownStyle} />
      ) : (
        <Text selectable className="text-sm leading-5 text-foreground">
          {props.result}
        </Text>
      )}
    </View>
  );
}

export function ThreadSubagentsSheet(_props: ThreadSubagentsSheetProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  useThreadSelection();
  const detail = useSelectedThreadDetail();
  const groups = useMemo(
    () => sortGroupsForInspector(detail ? deriveSubagentInspectorGroups(detail) : []),
    [detail],
  );
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});
  const [expandedPrompts, setExpandedPrompts] = useState<Record<string, boolean>>({});
  const [copiedRowId, setCopiedRowId] = useState<string | null>(null);
  const copyFeedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iconColor = useThemeColor("--color-icon-subtle");
  const markdownBody = String(useThemeColor("--color-md-body"));
  const markdownStrong = String(useThemeColor("--color-md-strong"));
  const markdownLink = String(useThemeColor("--color-md-link"));
  const markdownCode = String(useThemeColor("--color-md-code-text"));
  const markdownCodeBackground = String(useThemeColor("--color-md-code-bg"));
  const markdownBorder = String(useThemeColor("--color-md-blockquote-border"));
  const markdownDivider = String(useThemeColor("--color-md-hr"));
  const regularFont = useFontFamily("regular");
  const boldFont = useFontFamily("bold");
  const markdownStyle = useMemo<NativeMarkdownTextStyle>(
    () => ({
      color: markdownBody,
      strongColor: markdownStrong,
      mutedColor: markdownBody,
      linkColor: markdownLink,
      inlineCodeColor: markdownCode,
      codeColor: markdownCode,
      codeBackgroundColor: markdownCodeBackground,
      codeBlockBackgroundColor: markdownCodeBackground,
      fileTextColor: markdownCode,
      skillTextColor: markdownCode,
      quoteMarkerColor: markdownBorder,
      dividerColor: markdownDivider,
      fontSize: 15,
      lineHeight: 22,
      headingFontSizes: [24, 21, 19, 17, 16, 15],
      fontFamily: regularFont,
      headingFontFamily: boldFont,
      boldFontFamily: boldFont,
    }),
    [
      boldFont,
      markdownBody,
      markdownBorder,
      markdownCode,
      markdownCodeBackground,
      markdownDivider,
      markdownLink,
      markdownStrong,
      regularFont,
    ],
  );

  useEffect(
    () => () => {
      if (copyFeedbackTimeoutRef.current) clearTimeout(copyFeedbackTimeoutRef.current);
    },
    [],
  );

  const onCopyRow = useCallback((rowId: string, value: string) => {
    copyTextWithHaptic(value, { target: "subagent-tool-row", feedback: "selection" });
    setCopiedRowId(rowId);
    if (copyFeedbackTimeoutRef.current) clearTimeout(copyFeedbackTimeoutRef.current);
    copyFeedbackTimeoutRef.current = setTimeout(() => {
      setCopiedRowId((current) => (current === rowId ? null : current));
      copyFeedbackTimeoutRef.current = null;
    }, 1_200);
  }, []);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <AndroidSheetHeader title="Subagents" onBack={() => navigation.goBack()} />
      ) : null}
      <ScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
        contentContainerStyle={
          groups.length === 0
            ? { flexGrow: 1, alignItems: "center", justifyContent: "center", padding: 24 }
            : undefined
        }
        contentContainerClassName={groups.length === 0 ? undefined : "gap-3 px-4 pt-2"}
      >
        {groups.length === 0 ? (
          <Text className="text-center text-sm font-t3-medium text-foreground-muted">
            No subagents in this thread.
          </Text>
        ) : null}
        {groups.map((group) => {
          const countLabel = toolCountLabel(group.children.length);
          return (
            <View
              key={group.entryId}
              className="gap-3 rounded-[18px] border border-border bg-card px-4 py-4"
            >
              <View className="flex-row items-start gap-2.5">
                <View className="h-7 w-6 items-center justify-center">
                  <SymbolView
                    name={{ ios: "sparkles", android: "auto_awesome" }}
                    size={15}
                    tintColor={iconColor}
                    type="monochrome"
                  />
                </View>
                <View className="min-w-0 flex-1">
                  <View className="flex-row items-center gap-2">
                    <Text
                      numberOfLines={1}
                      className="min-w-0 flex-1 text-sm font-t3-bold text-foreground"
                    >
                      {capitalizeName(group.name)}
                    </Text>
                    {countLabel ? (
                      <Text className="shrink-0 text-2xs font-t3-medium text-foreground-muted">
                        {countLabel}
                      </Text>
                    ) : null}
                  </View>
                  {group.description ? (
                    <Text numberOfLines={1} className="text-xs text-foreground-muted">
                      {group.description}
                    </Text>
                  ) : null}
                </View>
                <SubagentStatus group={group} iconColor={iconColor} />
              </View>

              {group.status === "running" && group.lastProgressSummary ? (
                <Text numberOfLines={1} className="pl-8 text-xs text-foreground-muted">
                  {group.lastProgressSummary}
                </Text>
              ) : null}

              {group.children.length > 0 ? (
                <ThreadWorkLog
                  activities={group.children}
                  copiedRowId={copiedRowId}
                  expandedRows={expandedRows}
                  iconSubtleColor={iconColor}
                  onCopyRow={onCopyRow}
                  onToggleRow={(rowId) =>
                    setExpandedRows((current) => ({ ...current, [rowId]: !current[rowId] }))
                  }
                />
              ) : (
                <Text className="text-xs text-foreground-muted">
                  Older tool activity is no longer available.
                </Text>
              )}

              {group.prompt ? (
                <PromptDisclosure
                  prompt={group.prompt}
                  expanded={expandedPrompts[group.entryId] ?? false}
                  iconColor={iconColor}
                  onToggle={() =>
                    setExpandedPrompts((current) => ({
                      ...current,
                      [group.entryId]: !current[group.entryId],
                    }))
                  }
                />
              ) : null}

              {group.status === "completed" && group.resultText ? (
                <ResultText result={group.resultText} markdownStyle={markdownStyle} />
              ) : null}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}
