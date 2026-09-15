/**
 * Persistent per-game logs for later strategy analysis. Each finished game is
 * stored as one structured record (board, settings, the recommended strategy,
 * the full move list, and the outcome) so a Claude session can mine many games
 * to learn which strategies/openings/boards win.
 *
 * Stored three ways, most-to-least durable: localStorage archive (survives
 * reloads), a one-click JSON export, and — when the local bridge is running —
 * appended to .context/game-logs.jsonl on disk automatically.
 */
import type { GameEvent } from "./events";
import type { AutopilotDecision } from "./autopilot";
import type { Hand } from "../engine/winnability";
import type { TrackingHealth } from "./handLedger";
import type { WireBuilding, WireRoad } from "./stateBridge";

export interface GameLogMove {
  t: number;
  player: string | null;
  text: string;
  mine: boolean;
}

export interface GameLogPlayer {
  name: string;
  isYou: boolean;
  vp: number;
  cards: number;
  pips: number;
  devCards: number;
  knightsPlayed: number;
}

export interface GameLogTile {
  q: number;
  r: number;
  kind: string;
  token: number | null;
}

/** A building on the final board — for post-game placement analysis. */
export interface GameLogBuilding {
  player: string | null;
  kind: "settlement" | "city";
  /** e.g. "8-wheat + 6-ore + 5-sheep (13 pips, 2:1 ore port)" */
  label: string;
  pips: number;
}

export interface GameLog {
  complete?: boolean;
  events?: Array<{ id: number; event: GameEvent }>;
  decisions?: Array<{ t: number; eventIndex: number; decision: AutopilotDecision;
    outcome?: { confirmed: boolean; resource?: import("../engine/types").Resource; cards?: number; eventId: number };
    hands: Array<{ name: string; hand: Hand; total: number | null; health: TrackingHealth; publicVp: number }>;
    buildings: WireBuilding[]; roads: WireRoad[];
    position?: Omit<import("../engine/types").GameState, "board">;
    planningInputs?: import("../engine/winnability").PlayerVictoryInput[];
    devCardIds?: number[]; bankDevCards?: number | null;
    robberHex?: { x: number; y: number } | null }>;
  boardGeometry?: import("../engine/types").Board;
  version: string; // bot build that played this game
  at: string; // ISO end time
  durationMs: number | null;
  you: string | null;
  won: boolean;
  winner: string | null;
  playerCount: number;
  settings: {
    friendlyRobber: boolean;
    victoryPointsToWin: number | null;
    discardLimit: number;
  };
  recommendedStrategy: string | null;
  board: { tiles: GameLogTile[]; ports: string[] };
  finalPlayers: GameLogPlayer[];
  /** final board positions (absent in logs from builds before v1.3) */
  buildings?: GameLogBuilding[];
  moves: GameLogMove[];
}

const KEY = "catanCopilot:gamelogs";
const MAX_LOGS = 40;

export function loadGameLogs(): GameLog[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as GameLog[]) : [];
  } catch {
    return [];
  }
}

export function saveGameLog(log: GameLog): boolean {
  try {
    const all = loadGameLogs();
    all.push(log);
    const retained = all.slice(-MAX_LOGS);
    const obsoleteCheckpoints = Object.keys(localStorage).filter(key =>
      key.startsWith("catanCopilot:ledger:") && key !== `catanCopilot:ledger:${location.href}`);
    while (retained.length) {
      try { localStorage.setItem(KEY, JSON.stringify(retained)); return true; }
      catch (error) {
        if (!(error instanceof DOMException) || error.name !== "QuotaExceededError") throw error;
        // Old per-game checkpoints are recovery caches, not the game archive.
        // Reclaim them first; never remove the current game's checkpoint.
        const obsolete = obsoleteCheckpoints.shift();
        if (obsolete) { localStorage.removeItem(obsolete); continue; }
        if (retained.length === 1) throw error;
        retained.shift();
      }
    }
  } catch {
    // storage full/unavailable — the export button + bridge still capture it
  }
  return false;
}

export function gameLogsSummary(logs: GameLog[]): string | null {
  if (logs.length === 0) return null;
  const completed = logs.filter((l) => l.complete !== false && l.winner !== null);
  const wins = completed.filter((l) => l.won).length;
  const incomplete = logs.length - completed.length;
  return `${completed.length} completed, ${wins}W-${completed.length - wins}L${incomplete ? `, ${incomplete} incomplete` : ""}`;
}
