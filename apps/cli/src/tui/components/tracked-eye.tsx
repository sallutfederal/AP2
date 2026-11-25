import { useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useState } from "react";

const SWEEP_X = 3;
const SWEEP_Y = 1;

/** Red-only palette; darker at the lids, hotter at the iris. */
const COLORS = {
	lid: "#8e1414",
	lidTop: "#c23b3b",
	lidBottom: "#6d1010",
	corner: "#590a0a",
	lash: "#a01212",
	shadow: "#2f0808",
	sclera: "#4d1c1c",
	vein: "#66191a",
	irisDark: "#b51313",
	irisEdge: "#e01a1a",
	irisBody: "#ff2323",
	pupil: "#160000",
	highlight: "#ffd9d9",
} as const;

interface Segment {
	text: string;
	fg: string;
}

interface Cell {
	ch: string;
	fg: string;
}

function buildGeometry(halfWidth: number) {
	return {
		w: halfWidth * 2 + 1,
		cx: halfWidth,
		yc: 7,
		arcTop: 4,
		arcBottom: 5,
		yMin: 7 - 4 - 2,
		yMax: 7 + 5 + 2,
		hw: halfWidth,
	};
}

function buildIris(halfWidth: number) {
	const radius = halfWidth >= 24 ? 3.8 : 2.8;
	return {
		radius,
		pupil: radius * 0.42,
		glint: {
			dx: -radius * 0.34,
			dy: -radius * 0.26,
			r: Math.max(0.7, radius * 0.2),
		},
	};
}

function lidRatio(absU: number, hw: number): number {
	return absU / hw;
}

function pushRun(segments: Segment[], text: string, fg: string | null): void {
	if (!text) return;
	if (!fg) return; // drop whitespace-only runs at the edges
	if (segments.length > 0 && segments[segments.length - 1].fg === fg) {
		segments[segments.length - 1].text += text;
		return;
	}
	segments.push({ text, fg });
}

function segmentsFromCells(row: Array<Cell | null>): Array<Segment> {
	const segments: Array<Segment> = [];
	let runText = "";
	let runFg: string | null = null;
	for (const cell of row) {
		const fg = cell ? cell.fg : null;
		if (fg !== runFg) {
			pushRun(segments, runText, runFg);
			runText = "";
			runFg = fg;
		}
		runText += cell ? cell.ch : " ";
	}
	pushRun(segments, runText, runFg);
	return segments;
}

interface EyeOptions {
	x: number; // pupil drift in cells
	y: number; // pupil drift rows (-1, 0, 1)
}

function buildEyeRows(halfWidth: number, opt: EyeOptions): Array<Array<Segment>> {
	const geo = buildGeometry(halfWidth);
	const iris = buildIris(halfWidth);
	const height = geo.yMax - geo.yMin + 1;
	const cells: Array<Array<Cell | null>> = [];
	for (let i = 0; i < height; i++) cells.push(new Array(geo.w).fill(null));

	for (let x = 0; x < geo.w; x++) {
		const u = x - geo.cx;
		const absU = Math.abs(u);
		if (absU > geo.hw) continue;

		const denom = Math.sqrt(Math.max(0, 1 - (u / geo.hw) ** 2));
		const lidT = Math.round(geo.yc - geo.arcTop * Math.pow(denom, 0.8));
		const lidB = Math.round(geo.yc + geo.arcBottom * Math.pow(denom, 0.8));
		const ratio = lidRatio(absU, geo.hw);

		// Upper and lower lash strokes along the lid curve.
		for (const [k, period] of [[1, 2] as const, [2, 2] as const]) {
			const ly = lidT - k;
			const ri = ly - geo.yMin;
			if (ri < 0 || ri >= height) continue;
			if (x % period !== (k === 1 ? 0 : 1)) continue;
			if (absU >= 0.8 * geo.hw) continue;
			cells[ri][x] = { ch: u < 0 ? "/" : "\\", fg: COLORS.lash };
		}
		const by = lidB + 1;
		const bri = by - geo.yMin;
		if (bri >= 0 && bri < height && absU > 0.55 * geo.hw && x % 2 === 0) {
			cells[bri][x] = { ch: u < 0 ? "\\" : "/", fg: COLORS.lidBottom };
		}

		const irisCx = geo.cx + opt.x;
		const irisCy = geo.yc + opt.y;
		const glintX = irisCx + iris.glint.dx;
		const glintY = irisCy + iris.glint.dy;

		for (let y = lidT; y <= lidB; y++) {
			const ri = y - geo.yMin;
			if (ri < 0 || ri >= height) continue;
			let cell: Cell | null = null;
			if (y === lidT) {
				if (lidT === lidB) {
					cell = { ch: u < 0 ? "<" : ">", fg: COLORS.corner };
				} else if (ratio < 0.3) {
					cell = { ch: "\u2580", fg: COLORS.lidTop };
				} else {
					cell = { ch: u < 0 ? "/" : "\\", fg: COLORS.lid };
				}
			} else if (y === lidB) {
				if (ratio < 0.3) {
					cell = { ch: "_", fg: COLORS.lidBottom };
				} else {
					cell = { ch: u < 0 ? "\\" : "/", fg: COLORS.lid };
				}
			} else {
				// Inside the eye: sclera, veins, iris, pupil, glint.
				const dist = Math.hypot(
					x - irisCx,
					y - irisCy,
				);
				const glint = Math.hypot(x - glintX, y - glintY);
				if (glint <= iris.glint.r) {
					cell = { ch: "\u2593", fg: COLORS.highlight };
				} else if (dist <= iris.pupil) {
					cell = { ch: "\u2588", fg: COLORS.pupil };
				} else if (dist <= iris.radius) {
					const ang =
						((Math.atan2(y - irisCy, x - irisCx) * 180) / Math.PI + 360) /
						45;
					const ch = Math.floor(ang) % 2 === 0 ? "/" : "\\";
					const fg =
						y - irisCy < -1.2
							? COLORS.irisDark
							: dist / iris.radius > 0.82
								? COLORS.irisEdge
								: COLORS.irisBody;
					cell = { ch, fg };
				} else if (dist <= iris.radius + 0.75) {
					cell = { ch: "\u2591", fg: COLORS.sclera };
				} else if (y - lidT <= 1 || lidB - y <= 1) {
					cell = { ch: "\u2592", fg: COLORS.shadow };
				} else {
					const seed = ((x * 2654435 + y * 40503) >>> 0) % 37;
					cell =
						seed === 0
							? { ch: "\u2592", fg: COLORS.vein }
							: { ch: "\u2591", fg: COLORS.sclera };
				}
			}
			cells[ri][x] = cell;
		}
	}

	return cells.map((row) => segmentsFromCells(row));
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

export function TrackedEye(props: { cursorX?: number; cursorY?: number }) {
	const { width, height } = useTerminalDimensions();
	const halfWidth = width >= 76 ? 30 : width >= 46 ? 18 : 11;
	const centerX = Math.floor(width / 2);
	// Rough on-screen vertical position of the eye in the centered home layout.
	const eyeCenterY = Math.floor(height / 2) - 8;
	const [offset, setOffset] = useState({ x: 0, y: 0 });

	const dx = (props.cursorX ?? centerX) - centerX;
	const targetX = Math.round(
		(clamp(dx, -centerX, centerX) / Math.max(centerX, 1)) * SWEEP_X,
	);
	const dy = (props.cursorY ?? eyeCenterY) - eyeCenterY;
	const targetY =
		dy < -3 ? -SWEEP_Y : dy > 10 ? SWEEP_Y : 0;

	useEffect(() => {
		const interval = setInterval(() => {
			setOffset((current) => {
				const stepX = targetX - current.x;
				const stepY = targetY - current.y;
				if (stepX === 0 && stepY === 0) return current;
				return {
					x: current.x + Math.sign(stepX),
					y: current.y + Math.sign(stepY),
				};
			});
		}, 40);

		return () => clearInterval(interval);
	}, [targetX, targetY]);

	const rows = useMemo(
		() => buildEyeRows(halfWidth, offset),
		[halfWidth, offset.x, offset.y],
	);

	return (
		<box width="100%" flexShrink={1} overflow="hidden">
			<box flexDirection="column" alignItems="center" width="100%">
				{rows.map((row, rowIdx) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: static eye frame with fixed row order
					<text key={`row-${rowIdx}`}>
						{row.map((seg, segIdx) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: static eye frame with fixed segment order
							<span key={`seg-${rowIdx}-${segIdx}`} fg={seg.fg}>
								{seg.text}
							</span>
						))}
					</text>
				))}
			</box>
		</box>
	);
}
