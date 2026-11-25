import { useTerminalDimensions } from "@opentui/react";
import {
	AutocompleteDropdown,
	type AutocompleteDropdownProps,
	DROPDOWN_MAX_HEIGHT,
} from "../components/autocomplete-dropdown";
import { InputBar, type TextareaHandle } from "../components/input-bar";
import {
	resolveModelDisplayName,
	resolveModelMaxInputTokens,
	StatusBar,
	type StatusBarCloud,
} from "../components/status-bar";
import { useSession } from "../contexts/session-context";
import { useTheme } from "../hooks/use-theme";
import {
	getInputRuleColor,
	getModeInputForeground,
	getModeInputPlaceholder,
} from "../palette";
import { getThemeModeAccent } from "../themes";
import { HOME_VIEW_MAX_WIDTH, type TuiProps } from "../types";

const AP2_LOGO_LINES: readonly string[] = [
	"   ░█████    ░██████    ░██████  ",
	"  ▒██░░░██   ▒██░░░██   ░   ░▒██ ",
	"  ▒███████   ▒██████░    ░█████░ ",
	"  ▒██▒ ▒██   ▒██▒  ░    ▒██░  ░  ",
	"  ░██▓ ▓██   ░██▓       ░███████ ",
	"   ▓▒░ ░▒▓    ▓▒░        ▓▒░ ░▒▓ ",
	"   ░     ░    ░          ░     ░ ",
];

const RED_LOGO_PALETTE: ReadonlyArray<{ mainFg: string; shadeFg: string }> = [
	{ mainFg: "#FF6B8E", shadeFg: "#D1224A" },
	{ mainFg: "#FF527C", shadeFg: "#C51F46" },
	{ mainFg: "#E83A62", shadeFg: "#B0163B" },
	{ mainFg: "#D1224A", shadeFg: "#990D2E" },
	{ mainFg: "#BA0A32", shadeFg: "#820724" },
	{ mainFg: "#990D2E", shadeFg: "#70051E" },
	{ mainFg: "#70051E", shadeFg: "#590317" },
];

const CYBERDATA_LOGO_PALETTE: ReadonlyArray<{
	mainFg: string;
	shadeFg: string;
}> = [
	{ mainFg: "#E6C2FF", shadeFg: "#9A28E8" },
	{ mainFg: "#D48CFF", shadeFg: "#841FD1" },
	{ mainFg: "#C86BFA", shadeFg: "#6F17B5" },
	{ mainFg: "#B84DFF", shadeFg: "#5B1099" },
	{ mainFg: "#9A28E8", shadeFg: "#470A7D" },
	{ mainFg: "#7A14C4", shadeFg: "#360661" },
	{ mainFg: "#5B1099", shadeFg: "#260347" },
];

function splitLogoSegments(
	line: string,
	mainFg: string,
	shadeFg: string,
): Array<{ text: string; fg: string }> {
	const segments: Array<{ text: string; fg: string }> = [];
	let currentText = "";
	let currentFg = mainFg;

	for (const ch of line) {
		const isShade = ch === "░" || ch === "▒" || ch === "▓";
		const fg = isShade ? shadeFg : mainFg;
		if (currentText && fg !== currentFg) {
			segments.push({ text: currentText, fg: currentFg });
			currentText = ch;
			currentFg = fg;
		} else {
			currentFg = fg;
			currentText += ch;
		}
	}
	if (currentText) {
		segments.push({ text: currentText, fg: currentFg });
	}
	return segments;
}

export function HomeView(props: {
	config: TuiProps["config"];
	inputValue: string;
	inputKey: number;
	onSubmit: () => void;
	onContentChange: (text: string) => void;
	onImagePaste: (dataUrl: string) => string;
	onLargeTextPaste: (text: string) => string;
	onInputFocusRequest?: () => void;
	repoStatus: {
		branch: string | null;
		diffStats: {
			files: number;
			additions: number;
			deletions: number;
		} | null;
	};
	textareaRef?: React.MutableRefObject<TextareaHandle | null>;
	autocomplete?: AutocompleteDropdownProps;
	onToggleMode: () => void;
	cloud?: StatusBarCloud;
}) {
	const {
		config,
		inputValue,
		inputKey,
		onSubmit,
		onContentChange,
		onImagePaste,
		onLargeTextPaste,
		repoStatus,
	} = props;
	const session = useSession();
	const { width } = useTerminalDimensions();
	const theme = useTheme();
	const terminalBg = theme.background;
	const defaultFg = theme.defaultForeground;
	const accent = getThemeModeAccent(theme, session.uiMode);
	const inputRuleColor = getInputRuleColor(terminalBg);
	const inputForeground = getModeInputForeground(session.uiMode, terminalBg);
	const inputPlaceholder = getModeInputPlaceholder(session.uiMode, terminalBg);
	const placeholder =
		session.uiMode === "plan" ? "Plan something..." : "What can I do for you?";
	const modelDisplayName = resolveModelDisplayName(config);
	const maxInputTokens = resolveModelMaxInputTokens(config);
	const hasAutocomplete =
		props.autocomplete?.mode && props.autocomplete.options.length > 0;
	const contentWidth = Math.min(width, HOME_VIEW_MAX_WIDTH);
	const logoPalette =
		theme.id === "cyberdata" ? CYBERDATA_LOGO_PALETTE : RED_LOGO_PALETTE;

	return (
		<box
			flexDirection="column"
			width="100%"
			height="100%"
			alignItems="center"
			justifyContent="center"
		>
			<box
				flexDirection="column"
				alignItems="center"
				justifyContent="center"
				marginBottom={1}
			>
				{AP2_LOGO_LINES.map((line, rowIndex) => {
					const colors = logoPalette[rowIndex] ?? RED_LOGO_PALETTE[0];
					const segments = splitLogoSegments(
						line,
						colors.mainFg,
						colors.shadeFg,
					);
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: static logo rows
						<box key={`logo-row-${rowIndex}`} flexDirection="row">
							<text>
								{segments.map((seg, segIndex) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: static logo segments
									<span key={`logo-seg-${rowIndex}-${segIndex}`} fg={seg.fg}>
										<strong>{seg.text}</strong>
									</span>
								))}
							</text>
						</box>
					);
				})}
				<box flexDirection="row" marginTop={1}>
					<text fg="#858585">
						<strong>security is an illusion.</strong>
					</text>
				</box>
			</box>
			<box marginTop={1} marginBottom={1} flexShrink={0}>
				<text fg={defaultFg}>
					<strong>What can I do for you?</strong>
				</text>
			</box>
			<box marginBottom={1} flexShrink={0}>
				<text fg="gray">
					<em>
						Use / for slash commands, @ for file mentions, Ctrl+P for menu
					</em>
				</text>
			</box>

			<box flexDirection="column" width={contentWidth} flexShrink={0}>
				<InputBar
					accent={accent}
					ruleColor={inputRuleColor}
					inputForeground={inputForeground}
					inputPlaceholder={inputPlaceholder}
					placeholder={placeholder}
					initialValue={inputValue}
					inputKey={inputKey}
					onSubmit={onSubmit}
					onContentChange={onContentChange}
					onImagePaste={onImagePaste}
					onLargeTextPaste={onLargeTextPaste}
					onFocusRequest={props.onInputFocusRequest}
					textareaRef={props.textareaRef}
				/>

				<box flexDirection="column" height={DROPDOWN_MAX_HEIGHT + 1}>
					{hasAutocomplete && props.autocomplete ? (
						<AutocompleteDropdown
							{...props.autocomplete}
							accent={accent}
							containerWidth={Math.min(width, HOME_VIEW_MAX_WIDTH)}
						/>
					) : (
						<box marginTop={1}>
							<StatusBar
								providerId={config.providerId}
								modelId={modelDisplayName}
								totalTokens={session.lastTotalTokens}
								totalCost={session.lastTotalCost}
								maxInputTokens={maxInputTokens}
								uiMode={session.uiMode}
								autoApproveAll={session.autoApproveAll}
								workspaceName={
									config.workspaceRoot
										? (config.workspaceRoot.split("/").pop() ?? "")
										: ""
								}
								gitBranch={repoStatus.branch}
								gitDiffStats={repoStatus.diffStats}
								onToggleMode={props.onToggleMode}
								variant="home"
								cloud={props.cloud}
							/>
						</box>
					)}
				</box>
			</box>
		</box>
	);
}
