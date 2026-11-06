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
				{/* 3D extrusion shadow layer (rendered first, behind main) */}
				<box flexDirection="row" marginLeft={1}>
					<text fg="#FF527C">
						<strong>{"   █████  ██████  ██████  "}</strong>
					</text>
				</box>
				<box flexDirection="row" marginLeft={1}>
					<text fg="#FF527C">
						<strong>{"  ██   ██ ██   ██      ██  "}</strong>
					</text>
				</box>
				<box flexDirection="row" marginLeft={1}>
					<text fg="#FF527C">
						<strong>{"  ███████ ██████   █████   "}</strong>
					</text>
				</box>
				<box flexDirection="row" marginLeft={1}>
					<text fg="#FF527C">
						<strong>{"  ██   ██ ██     ██        "}</strong>
					</text>
				</box>
				<box flexDirection="row" marginLeft={1}>
					<text fg="#FF527C">
						<strong>{"  ██   ██ ██     ███████  "}</strong>
					</text>
				</box>
				{/* Main filled layer (rendered on top, shifted up to overlap shadow) */}
				<box flexDirection="row" marginTop={-5}>
					<text fg="#FF527C">
						<strong>{"  █████  ██████  ██████  "}</strong>
					</text>
				</box>
				<box flexDirection="row">
					<text fg="#E83A62">
						<strong>{" ██   ██ ██   ██      ██  "}</strong>
					</text>
				</box>
				<box flexDirection="row">
					<text fg="#D1224A">
						<strong>{" ███████ ██████   █████   "}</strong>
					</text>
				</box>
				<box flexDirection="row">
					<text fg="#BA0A32">
						<strong>{" ██   ██ ██     ██        "}</strong>
					</text>
				</box>
				<box flexDirection="row">
					<text fg="#C51F46">
						<strong>{" ██   ██ ██     ███████  "}</strong>
					</text>
				</box>
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
