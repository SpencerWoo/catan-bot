import { GameState, PlayerId } from '../engine/types';
import { isVertexBuildable } from '../engine/analysis';
import { reachableRoadPath } from './placement';

export interface RoadThreat {
  opponent: PlayerId;
  vertexId: number;
  roadsNeeded: number;
  reason: 'destination' | 'adjacent-settlement' | 'route-cut';
}

/** Geometric threats deliberately do not assume an unknown opponent hand is empty. */
export function settlementRoadThreats(
  state: GameState, player: PlayerId, target: number, path: number[],
): RoadThreat[] {
  const sites = new Map<number, RoadThreat['reason']>();
  for (const id of path) {
    const edge = state.board.edges[id];
    sites.set(edge.a, 'route-cut'); sites.set(edge.b, 'route-cut');
  }
  for (const id of state.board.vertices[target].adjacent) sites.set(id, 'adjacent-settlement');
  sites.set(target, 'destination');
  const opponents = new Set(state.buildings.filter(b => b.player !== player).map(b => b.player));
  const threats: RoadThreat[] = [];
  for (const [vertexId, reason] of sites) {
    if (!isVertexBuildable(state, vertexId)) continue;
    for (const opponent of opponents) {
      if (state.buildings.filter(b => b.player === opponent && b.kind === "settlement").length >= 5) continue;
      const route = reachableRoadPath(state, opponent, vertexId);
      if (route !== null && route.length <= path.length &&
          route.length <= 15 - state.roads.filter(r => r.player === opponent).length) {
        threats.push({ opponent, vertexId, roadsNeeded: route.length, reason });
      }
    }
  }
  return threats;
}

/** Only immediately connected, legal opponent settlement sites can cut a road now. */
export function opponentCutSites(state: GameState, player: PlayerId): Array<{ vertexId: number; player: PlayerId }> {
  const sites: Array<{ vertexId: number; player: PlayerId }> = [];
  const network = new Set(state.roads.filter(r => r.player === player)
    .flatMap(r => [state.board.edges[r.edgeId].a, state.board.edges[r.edgeId].b]));
  for (const road of state.roads) if (road.player !== player &&
      state.buildings.filter(b => b.player === road.player && b.kind === "settlement").length < 5) {
    for (const vertexId of [state.board.edges[road.edgeId].a, state.board.edges[road.edgeId].b]) {
      if (network.has(vertexId) && isVertexBuildable(state, vertexId) &&
          !sites.some(s => s.vertexId === vertexId && s.player === road.player)) sites.push({ vertexId, player: road.player });
    }
  }
  return sites;
}
