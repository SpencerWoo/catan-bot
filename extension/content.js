var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
(function() {
  "use strict";
  const RESOURCES = ["wood", "brick", "sheep", "wheat", "ore"];
  function pips(token) {
    if (token === null) return 0;
    return 6 - Math.abs(7 - token);
  }
  function turnsToAfford(cost, hand, production, ratios = {}) {
    const covered = (turns) => {
      let shortage = 0, exchange = 0;
      for (const r of RESOURCES) {
        const spare = hand[r] + production[r] * turns - (cost[r] ?? 0);
        if (spare < -1e-9) shortage += Math.ceil(-spare - 1e-9);
        else exchange += Math.floor((spare + 1e-9) / (ratios[r] ?? 4));
      }
      return exchange + 1e-9 >= shortage;
    };
    if (covered(0)) return 0;
    if (RESOURCES.every((r) => production[r] <= 0)) return Infinity;
    let hi = 1;
    while (hi < 4096 && !covered(hi)) hi *= 2;
    if (!covered(hi)) return Infinity;
    let lo = 0;
    for (let i = 0; i < 28; i++) {
      const mid = (lo + hi) / 2;
      if (covered(mid)) hi = mid;
      else lo = mid;
    }
    return hi;
  }
  function gameHorizon(finishTimes) {
    const finite = finishTimes.filter((n) => Number.isFinite(n) && n >= 0);
    const turns = finite.length ? Math.min(...finite) : 24;
    return { turns, urgency: 1 / (1 + turns) };
  }
  function evaluateBuilds(options, hand, production, ratios, remaining, gap, horizon) {
    const resourceValue = (r) => {
      const short = Math.max(0, (remaining[r] ?? 0) - hand[r]);
      const supplied = production[r] * horizon.turns;
      const usefulShare = short / Math.max(1, short + supplied);
      return usefulShare + (1 - usefulShare) / (ratios[r] ?? 4);
    };
    return options.map((option) => {
      const wait = turnsToAfford(option.cost, hand, production, ratios) + (option.delay ?? 0);
      const lifetime = Math.max(0, horizon.turns - wait);
      let productionValue = RESOURCES.reduce((s, r) => s + option.production[r] * lifetime * resourceValue(r), 0);
      if (option.ratios) for (const r of RESOURCES) {
        const surplus = Math.max(0, hand[r] + production[r] * lifetime - (remaining[r] ?? 0) - (option.cost[r] ?? 0));
        productionValue += surplus * Math.max(0, 1 / (option.ratios[r] ?? 4) - 1 / (ratios[r] ?? 4));
      }
      const points = Math.min(Math.max(0, gap), option.vp);
      const wins = option.kind !== "dev" && points >= gap && gap > 0;
      const discount = Number.isFinite(wait) ? Math.exp(-wait / (1 + horizon.turns)) / (1 + wait) : 0;
      const score = (points + productionValue / 4) * discount + (wins && wait === 0 ? 100 : 0);
      return { ...option, wait, score, productionValue };
    }).sort((a, b) => b.score - a.score || a.wait - b.wait || a.kind.localeCompare(b.kind));
  }
  const BUILD = {
    city: { ore: 3, wheat: 2 },
    settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
    road: { wood: 1, brick: 1 },
    dev: { ore: 1, sheep: 1, wheat: 1 }
  };
  const VP_CARD_RATE = 5 / 25;
  const BONUS_VP = 2;
  const TAU = 2;
  function costCards(c) {
    return RESOURCES.reduce((s, r) => s + (c[r] ?? 0), 0);
  }
  function addCost(a, b) {
    const out = { ...a };
    for (const r of RESOURCES) if (b[r]) out[r] = (out[r] ?? 0) + (b[r] ?? 0);
    return out;
  }
  function scaleCost(c, k) {
    const out = {};
    for (const r of RESOURCES) if (c[r]) out[r] = (c[r] ?? 0) * k;
    return out;
  }
  function buysFor(p, ctx, holdsLA, holdsLR, laReach, lrReach, knightsToLA, roadsToLR) {
    var _a, _b;
    const buys = [];
    const cityN = Math.min(p.citiesLeft ?? Infinity, p.settlementsOnBoard);
    for (let i = 0; i < cityN; i++) {
      buys.push({
        kind: "city",
        vp: 1,
        cost: BUILD.city,
        note: "upgrade a settlement to a city",
        production: ((_a = p.cityProduction) == null ? void 0 : _a[i]) ?? Object.fromEntries(RESOURCES.map((r) => [
          r,
          p.production[r] / Math.max(1, p.settlementsOnBoard + 2 * (4 - (p.citiesLeft ?? 4)))
        ]))
      });
    }
    const settN = p.settlementsLeft ?? 0;
    const freeSpots = p.settlementSpotOpen ? 1 : 0;
    const routes = (_b = p.settlementRoutes) == null ? void 0 : _b.slice().sort((a, b) => a.edges.length - b.edges.length);
    for (let i = 0; i < ((routes == null ? void 0 : routes.length) ?? settN); i++) {
      const route = routes == null ? void 0 : routes[i];
      const roads = route ? route.edges.length : i >= freeSpots ? 1 : 0;
      if (roads > (p.roadsLeft ?? 0)) continue;
      buys.push({
        kind: "settlement",
        vp: 1,
        cost: addCost(BUILD.settlement, scaleCost(BUILD.road, roads)),
        note: roads ? `${roads} road${roads === 1 ? "" : "s"} + settlement` : "settlement on an open spot",
        production: route == null ? void 0 : route.production,
        vertexId: route == null ? void 0 : route.vertexId,
        roadEdges: route == null ? void 0 : route.edges,
        conflicts: route == null ? void 0 : route.conflicts
      });
      if (route && (p.citiesLeft ?? 0) > 0) buys.push({
        kind: "city",
        vp: 1,
        cost: BUILD.city,
        note: "upgrade the planned settlement to a city",
        production: route.production,
        vertexId: route.vertexId,
        requiresSettlement: route.vertexId
      });
    }
    if (!holdsLA && laReach) {
      buys.push({
        kind: "largest-army",
        vp: BONUS_VP,
        cost: scaleCost(BUILD.dev, Math.max(0, knightsToLA - (p.knightsInHand ?? 0)) / (14 / 25)),
        delay: Math.max(0, knightsToLA - ((p.playableKnights ?? 0) > 0 ? 1 : 0)),
        note: `${knightsToLA} more knight${knightsToLA > 1 ? "s" : ""} for Largest Army`
      });
    }
    if (!holdsLR && lrReach) {
      buys.push({
        kind: "longest-road",
        vp: BONUS_VP,
        cost: scaleCost(BUILD.road, roadsToLR),
        roadEdges: p.longestRoadPath ?? void 0,
        note: `${roadsToLR} more road${roadsToLR > 1 ? "s" : ""} for Longest Road`
      });
    }
    const perVp = Math.round(1 / VP_CARD_RATE);
    const vpDevCap = ctx.devDeckLeft === null ? 6 : Math.floor(ctx.devDeckLeft * VP_CARD_RATE + 1e-3);
    for (let i = 0; i < vpDevCap; i++) {
      buys.push({ kind: "vp-dev", vp: 1, cost: scaleCost(BUILD.dev, perVp), note: "victory-point dev card (expected)" });
    }
    return buys;
  }
  function cheapestPlan(buys, gap, player) {
    var _a, _b;
    if (gap <= 0) return [];
    const rate = Object.fromEntries(RESOURCES.map((r) => [r, player.production[r] * (player.rollsPerTurn ?? 2)]));
    const dp = Array.from({ length: Math.ceil(gap) + 1 }, () => []);
    dp[0] = [{ items: [], cost: {}, time: 0, roads: 0, settlements: 0, cities: 0 }];
    for (const b of buys) {
      for (let v = dp.length - 2; v >= 0; v--) {
        for (const c of [...dp[v]]) {
          if (b.requiresSettlement !== void 0 && !c.items.some((x) => x.kind === "settlement" && x.vertexId === b.requiresSettlement)) continue;
          if (b.kind === "settlement" && b.vertexId !== void 0 && c.items.some((x) => {
            var _a2;
            return x.vertexId === b.vertexId || ((_a2 = x.conflicts) == null ? void 0 : _a2.includes(b.vertexId));
          })) continue;
          const cities = c.cities + (b.kind === "city" ? 1 : 0);
          if (cities > (player.citiesLeft ?? 0)) continue;
          const settlements = c.settlements + (b.kind === "settlement" ? 1 : 0);
          if (settlements - c.cities > (player.settlementsLeft ?? 0)) continue;
          const edges = new Set(c.items.flatMap((x) => x.roadEdges ?? []));
          const extraRoads = b.roadEdges ? b.roadEdges.filter((id) => !edges.has(id)).length : b.kind === "longest-road" ? b.cost.wood ?? 0 : b.kind === "settlement" ? (b.cost.wood ?? 1) - 1 : 0;
          const roads = c.roads + extraRoads;
          if (roads > (player.roadsLeft ?? 0)) continue;
          const cost = addCost(c.cost, b.cost);
          const shared = (((_a = b.roadEdges) == null ? void 0 : _a.length) ?? extraRoads) - extraRoads;
          if (shared > 0) {
            cost.wood = (cost.wood ?? 0) - shared;
            cost.brick = (cost.brick ?? 0) - shared;
          }
          const delay = Math.max(b.delay ?? 0, ...c.items.map((x) => x.delay ?? 0));
          const time = turnsToAfford(cost, player.hand, rate, player.bankRatios) + delay;
          const nv = Math.min(dp.length - 1, v + b.vp);
          dp[nv].push({ items: [...c.items, b], cost, time, roads, settlements, cities });
        }
        for (let n = v + 1; n < dp.length; n++) {
          dp[n].sort((a, b2) => a.time - b2.time || costCards(a.cost) - costCards(b2.cost));
          dp[n] = dp[n].slice(0, 24);
        }
      }
    }
    return ((_b = dp[dp.length - 1].sort((a, b) => sequenceTime(a.items, player) - sequenceTime(b.items, player))[0]) == null ? void 0 : _b.items) ?? [];
  }
  function sequenceTime(steps, p) {
    var _a, _b, _c;
    const hand = { ...p.hand };
    const rolls = p.rollsPerTurn ?? 2;
    const rate = Object.fromEntries(RESOURCES.map((r) => [r, p.production[r] * rolls]));
    const usedRoads = /* @__PURE__ */ new Set();
    let elapsed = 0;
    for (const step of steps) {
      const cost = { ...step.cost };
      for (const id of step.roadEdges ?? []) {
        if (usedRoads.has(id)) {
          cost.wood = (cost.wood ?? 0) - 1;
          cost.brick = (cost.brick ?? 0) - 1;
        }
        usedRoads.add(id);
      }
      const wait = turnsToAfford(cost, hand, rate, p.bankRatios);
      if (!Number.isFinite(wait)) return Infinity;
      elapsed += wait;
      let missing = 0;
      for (const r of RESOURCES) {
        hand[r] += rate[r] * wait - (cost[r] ?? 0);
        if (hand[r] < -1e-9) {
          const bought = Math.ceil(-hand[r] - 1e-9);
          missing += bought;
          hand[r] += bought;
        }
      }
      for (const r of [...RESOURCES].sort((a, b) => {
        var _a2, _b2;
        return (((_a2 = p.bankRatios) == null ? void 0 : _a2[a]) ?? 4) - (((_b2 = p.bankRatios) == null ? void 0 : _b2[b]) ?? 4);
      })) {
        const take = Math.min(Math.ceil(missing - 1e-9), Math.floor((hand[r] + 1e-9) / (((_a = p.bankRatios) == null ? void 0 : _a[r]) ?? 4)));
        hand[r] -= take * (((_b = p.bankRatios) == null ? void 0 : _b[r]) ?? 4);
        missing -= take;
      }
      for (const r of RESOURCES) rate[r] += (((_c = step.production) == null ? void 0 : _c[r]) ?? 0) * rolls;
    }
    return elapsed + Math.max(0, ...steps.map((s) => s.delay ?? 0));
  }
  function summarise(p, plan, eliminated, laReach, lrReach) {
    if (p.publicVp <= 0 && plan.length === 0 && eliminated) return "not in the game yet";
    if (eliminated) return "no verified path to the target with the available pieces and routes";
    if (plan.length === 0) return "already at the target";
    const counts = /* @__PURE__ */ new Map();
    for (const s2 of plan) counts.set(s2.kind, (counts.get(s2.kind) ?? 0) + 1);
    const label = {
      city: ["city", "cities"],
      settlement: ["settlement", "settlements"],
      "largest-army": ["Largest Army", "Largest Army"],
      "longest-road": ["Longest Road", "Longest Road"],
      "vp-dev": ["VP dev card", "VP dev cards"]
    };
    const parts = [];
    for (const [kind, n] of counts) parts.push(`${n} ${n > 1 ? label[kind][1] : label[kind][0]}`);
    let s = parts.join(" + ");
    if ((p.hiddenVp ?? 0) > 0) s = `(+${p.isYou ? "" : "~"}${Number((p.hiddenVp ?? 0).toFixed(1))} hidden) ` + s;
    if ((p.citiesLeft ?? 1) === 0 && p.settlementsOnBoard > 0) s += " (no cities left)";
    if (!laReach && !lrReach && (p.roadsLeft ?? 1) === 0) s += "; roads spent";
    return s;
  }
  function analyzeVictory(players, ctx) {
    const maxKnights = Math.max(0, ...players.map((p) => p.knightsPlayed));
    const knightLeaders = players.filter((p) => p.knightsPlayed === maxKnights && maxKnights >= 3);
    const maxRoad = Math.max(0, ...players.map((p) => p.longestRoadLen));
    const roadLeaders = players.filter((p) => p.longestRoadLen === maxRoad && maxRoad >= 5);
    const plans = players.map((p) => {
      var _a;
      const holdsLA = p.holdsLargestArmy ?? (knightLeaders.length === 1 && knightLeaders[0].name === p.name);
      const holdsLR = p.holdsLongestRoad ?? (roadLeaders.length === 1 && roadLeaders[0].name === p.name);
      const knightsToLA = holdsLA ? 0 : Math.max(3, maxKnights + 1) - p.knightsPlayed;
      const laReach = !holdsLA && knightsToLA >= 1 && (ctx.devDeckLeft === null || ctx.devDeckLeft + (p.knightsInHand ?? 0) >= knightsToLA);
      const roadsToLR = holdsLR ? 0 : p.longestRoadPath === null ? Infinity : ((_a = p.longestRoadPath) == null ? void 0 : _a.length) ?? Math.max(5, maxRoad + 1) - p.longestRoadLen;
      const lrReach = !holdsLR && roadsToLR >= 1 && (p.roadsLeft ?? 0) >= roadsToLR;
      const gap = Math.ceil(ctx.target - p.publicVp - (p.hiddenVp ?? 0));
      const buys = buysFor(p, ctx, holdsLA, holdsLR, laReach, lrReach, knightsToLA, roadsToLR);
      const maxAttainable = buys.reduce((s, b) => s + b.vp, 0);
      let eliminated = gap > 0 && maxAttainable < gap;
      const won = gap <= 0;
      const chosen = won ? [] : cheapestPlan(buys, gap, p);
      if (!won && chosen.length === 0) eliminated = true;
      const steps = chosen.map((b) => ({ kind: b.kind, vp: b.vp, cost: b.cost, note: b.note, delay: b.delay, production: b.production, vertexId: b.vertexId, roadEdges: b.roadEdges }));
      const planVp = steps.reduce((s, b) => s + b.vp, 0);
      const fundedRoads = /* @__PURE__ */ new Set();
      const totalCost = steps.reduce((acc, s) => {
        const next = addCost(acc, s.cost);
        for (const id of s.roadEdges ?? []) {
          if (fundedRoads.has(id)) {
            next.wood = (next.wood ?? 0) - 1;
            next.brick = (next.brick ?? 0) - 1;
          }
          fundedRoads.add(id);
        }
        return next;
      }, {});
      const need = {};
      for (const r of RESOURCES) {
        const n = (totalCost[r] ?? 0) - p.hand[r];
        if (n > 0) need[r] = n;
      }
      const turnsToWin = won ? 0 : eliminated ? Infinity : sequenceTime(steps, p);
      return {
        name: p.name,
        isYou: p.isYou,
        publicVp: p.publicVp,
        target: ctx.target,
        eliminated,
        steps,
        planVp,
        need,
        turnsToWin,
        winProb: 0,
        largestArmyReachable: laReach,
        longestRoadReachable: lrReach,
        summary: summarise(p, steps, eliminated, laReach, lrReach)
      };
    });
    const live = plans.filter((p) => !p.eliminated && Number.isFinite(p.turnsToWin));
    const tmin = Math.min(...live.map((p) => p.turnsToWin), Infinity);
    let wsum = 0;
    const weights = plans.map((p) => {
      if (p.eliminated || !Number.isFinite(p.turnsToWin)) return 0;
      const w = Math.exp(-(p.turnsToWin - tmin) / TAU);
      wsum += w;
      return w;
    });
    plans.forEach((p, i) => {
      p.winProb = wsum > 0 ? weights[i] / wsum : 0;
    });
    return plans.sort((a, b) => b.winProb - a.winProb);
  }
  const empty = () => ({ wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 });
  const total = (h) => RESOURCES.reduce((s, r) => s + (h[r] ?? 0), 0);
  class HandLedger {
    constructor(you, opponent, complete = false) {
      __publicField(this, "events", /* @__PURE__ */ new Map());
      __publicField(this, "anchor", null);
      this.you = you;
      this.opponent = opponent;
      this.complete = complete;
    }
    get lastSnapshot() {
      return this.anchor ? structuredClone(this.anchor.snapshot) : null;
    }
    record(id, event) {
      if (this.anchor && id <= this.anchor.id && JSON.stringify(this.events.get(id)) !== JSON.stringify(event)) this.anchor = null;
      this.events.set(id, event);
    }
    project(snapshot) {
      if (!this.complete) return { health: "incomplete", reason: "Opening resource history missing", opponent: null };
      const pool = empty();
      const own = this.anchor ? { ...this.anchor.snapshot.mine } : empty();
      let ownTotal = total(own);
      let ownIdentityKnown = true;
      let afterAnchor = !this.anchor;
      let invalid = false;
      const change = (player, delta, factor = 1) => {
        if (player !== this.you && player !== this.opponent) {
          invalid = true;
          return;
        }
        for (const r of RESOURCES) {
          pool[r] += factor * (delta[r] ?? 0);
          if (afterAnchor && player === this.you) own[r] += factor * (delta[r] ?? 0);
        }
        if (afterAnchor && player === this.you) ownTotal += factor * total(delta);
      };
      for (const [id, ev] of [...this.events].sort(([a], [b]) => a - b)) {
        afterAnchor = !this.anchor || id > this.anchor.id;
        switch (ev.type) {
          case "got":
          case "starting-resources":
          case "take-from-bank":
            change(ev.player, ev.resources);
            break;
          case "discard":
            change(ev.player, ev.resources, -1);
            break;
          case "build":
            change(ev.player, BUILD[ev.what], -1);
            break;
          case "buy-dev":
            change(ev.player, BUILD.dev, -1);
            break;
          case "bank-trade":
            change(ev.player, ev.delta);
            break;
          case "player-trade": {
            const partner = ev.partner ?? (ev.player === this.you ? this.opponent : this.you);
            if (ev.player === partner) {
              invalid = true;
              break;
            }
            change(ev.player, ev.delta);
            change(partner, ev.delta, -1);
            break;
          }
          case "steal-known":
          case "steal-unknown": {
            const thief = ev.thief ?? this.you;
            const victim = ev.victim ?? this.you;
            if ((/* @__PURE__ */ new Set([thief, victim, this.you, this.opponent])).size !== 2 || thief === victim) {
              invalid = true;
              break;
            }
            if (!afterAnchor) break;
            const sign = thief === this.you ? 1 : -1;
            ownTotal += sign;
            if (ev.type === "steal-known") own[ev.resource] += sign;
            else ownIdentityKnown = false;
            break;
          }
          case "monopoly-steal": {
            if (!afterAnchor) break;
            const sign = ev.player === this.you ? 1 : -1;
            ownTotal += sign * ev.count;
            own[ev.resource] += sign * ev.count;
            break;
          }
        }
      }
      const opponent = empty();
      for (const r of RESOURCES) opponent[r] = pool[r] - snapshot.mine[r];
      const consistent = !invalid && ownTotal === total(snapshot.mine) && total(opponent) === snapshot.opponentTotal && RESOURCES.every((r) => Number.isInteger(opponent[r]) && opponent[r] >= 0 && (!ownIdentityKnown || own[r] === snapshot.mine[r]));
      if (consistent) this.anchor = { id: Math.max(-1, ...this.events.keys()), snapshot: structuredClone(snapshot) };
      return consistent ? { health: "exact", reason: "1v1 ledger agrees with private hand and both server totals", opponent } : { health: "repairing", reason: "Waiting for resource events and server hands to agree", opponent: null };
    }
    /** Serializable history, also used by replay tests and game exports. */
    export() {
      return [...this.events].sort(([a], [b]) => a - b).map(([id, event]) => ({ id, event }));
    }
  }
  function confirmedMonopolyHaul(players, you, resource) {
    let haul = 0;
    let opponents = 0;
    for (const p of players) {
      if (p.name === you) continue;
      opponents++;
      if (p.trackingHealth !== "exact" || p.serverCards !== total(p.hand)) return 0;
      haul += p.hand[resource];
    }
    return opponents > 0 ? haul : 0;
  }
  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = a + 1831565813 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const SQRT3$1 = Math.sqrt(3);
  function hexCenter(q, r) {
    return { x: SQRT3$1 * q + SQRT3$1 / 2 * r, y: 1.5 * r };
  }
  function hexCorner(cx, cy, i) {
    const angle = Math.PI / 180 * (60 * i - 30);
    return { x: cx + Math.cos(angle), y: cy + Math.sin(angle) };
  }
  function vkey(x, y) {
    const rx = Math.round(x * 100) || 0;
    const ry = Math.round(y * 100) || 0;
    return `${rx},${ry}`;
  }
  function buildBoard(seed, tiles) {
    const hexes = tiles.map((t, id) => {
      const { x, y } = hexCenter(t.q, t.r);
      return { id, q: t.q, r: t.r, kind: t.kind, token: t.token, cx: x, cy: y };
    });
    const vertexByKey = /* @__PURE__ */ new Map();
    const vertices = [];
    const cornerIds = [];
    for (const h of hexes) {
      const ids = [];
      for (let i = 0; i < 6; i++) {
        const { x, y } = hexCorner(h.cx, h.cy, i);
        const key = vkey(x, y);
        let v = vertexByKey.get(key);
        if (!v) {
          v = { id: vertices.length, x, y, hexIds: [], adjacent: [], port: null };
          vertexByKey.set(key, v);
          vertices.push(v);
        }
        v.hexIds.push(h.id);
        ids.push(v.id);
      }
      cornerIds.push(ids);
    }
    const edgeByKey = /* @__PURE__ */ new Map();
    const edges = [];
    for (const ids of cornerIds) {
      for (let i = 0; i < 6; i++) {
        const a = ids[i];
        const b = ids[(i + 1) % 6];
        const key = a < b ? `${a}-${b}` : `${b}-${a}`;
        if (!edgeByKey.has(key)) {
          const e = { id: edges.length, a, b };
          edgeByKey.set(key, e);
          edges.push(e);
          vertices[a].adjacent.push(b);
          vertices[b].adjacent.push(a);
        }
      }
    }
    return { seed, hexes, vertices, edges };
  }
  function hexCornerPoints(hex) {
    return Array.from({ length: 6 }, (_, i) => hexCorner(hex.cx, hex.cy, i));
  }
  function colonistCornerToPixel(c) {
    const { x, y } = hexCenter(c.x, c.y);
    return hexCorner(x, y, c.z === 1 ? 2 : 5);
  }
  function colonistEdgeToPixels(e) {
    const { x, y } = hexCenter(e.x, e.y);
    const i = 5 - e.z;
    return [hexCorner(x, y, i), hexCorner(x, y, i - 1)];
  }
  function findVertexAt(board, x, y) {
    let best = null;
    let bestD = 0.05;
    for (const v of board.vertices) {
      const d = Math.hypot(v.x - x, v.y - y);
      if (d < bestD) {
        best = v;
        bestD = d;
      }
    }
    return best;
  }
  function findEdgeBetween(board, a, b) {
    return board.edges.find(
      (e) => e.a === a && e.b === b || e.a === b && e.b === a
    ) ?? null;
  }
  function vertexPips(board, vertexId) {
    return board.vertices[vertexId].hexIds.reduce(
      (sum2, hid) => sum2 + pips(board.hexes[hid].token),
      0
    );
  }
  function resourceAbundance(board) {
    const out = Object.fromEntries(RESOURCES.map((r) => [r, 0]));
    for (const h of board.hexes) {
      if (h.kind !== "desert") out[h.kind] += pips(h.token);
    }
    return out;
  }
  function scarcityWeights(board) {
    const abundance = resourceAbundance(board);
    const avg = RESOURCES.reduce((s, r) => s + abundance[r], 0) / RESOURCES.length;
    const out = {};
    for (const r of RESOURCES) {
      out[r] = Math.min(1.8, Math.max(0.6, avg / Math.max(1, abundance[r])));
    }
    return out;
  }
  function playerProduction(state, player) {
    const out = Object.fromEntries(RESOURCES.map((r) => [r, 0]));
    for (const b of state.buildings) {
      if (b.player !== player) continue;
      const mult = b.kind === "city" ? 2 : 1;
      for (const hid of state.board.vertices[b.vertexId].hexIds) {
        const h = state.board.hexes[hid];
        if (h.kind !== "desert" && h.token !== null) {
          out[h.kind] += pips(h.token) / 36 * mult;
        }
      }
    }
    return out;
  }
  function isVertexBuildable(state, vertexId) {
    const occupied = new Set(state.buildings.map((b) => b.vertexId));
    if (occupied.has(vertexId)) return false;
    return !state.board.vertices[vertexId].adjacent.some((n) => occupied.has(n));
  }
  function scoreVertex(board, vertexId, weights) {
    const v = board.vertices[vertexId];
    const notes = [];
    const resources = [];
    const pipsByKind = {};
    const pipsByToken = /* @__PURE__ */ new Map();
    let score = 0;
    let totalPips = 0;
    for (const hid of v.hexIds) {
      const h = board.hexes[hid];
      if (h.kind === "desert" || h.token === null) continue;
      const p = pips(h.token);
      totalPips += p;
      score += p * weights[h.kind];
      pipsByKind[h.kind] = (pipsByKind[h.kind] ?? 0) + p;
      pipsByToken.set(h.token, [...pipsByToken.get(h.token) ?? [], p]);
      if (!resources.includes(h.kind)) resources.push(h.kind);
    }
    score += (resources.length - 1) * 1.2;
    if (resources.length >= 3) notes.push("3-resource diversity");
    let dupPips = 0;
    for (const shares of pipsByToken.values()) {
      if (shares.length > 1) {
        const max = Math.max(...shares);
        dupPips += shares.reduce((s, p) => s + p, 0) - max;
      }
    }
    if (dupPips > 0) {
      score -= dupPips * 0.35;
      notes.push(`shared number token (-${(dupPips * 0.35).toFixed(1)})`);
    }
    if (v.port) {
      const feed = v.port.ratio === 2 ? pipsByKind[v.port.kind] ?? 0 : 0;
      notes.push(
        v.port.ratio === 2 ? `2:1 ${v.port.kind} port${feed > 0 ? ` fed by ${feed} pips here` : ""}` : "3:1 port"
      );
    }
    if (totalPips >= 10) notes.push(`strong production (${totalPips} pips)`);
    return { vertexId, score, pips: totalPips, resources, notes };
  }
  function rankVertices(state, weights, limit = 5) {
    return state.board.vertices.filter((v) => isVertexBuildable(state, v.id)).map((v) => scoreVertex(state.board, v.id, weights)).sort((a, b) => b.score - a.score).slice(0, limit);
  }
  function combineWeights(a, b) {
    const out = {};
    for (const r of RESOURCES) out[r] = a[r] * b[r];
    return out;
  }
  function buildingsOf(state, player) {
    return state.buildings.filter((b) => b.player === player);
  }
  function distanceFromPlayer(state, player, vertexId) {
    const sources = buildingsOf(state, player).map((b) => b.vertexId);
    if (sources.length === 0) return Infinity;
    const dist = /* @__PURE__ */ new Map();
    const queue = [];
    for (const s of sources) {
      dist.set(s, 0);
      queue.push(s);
    }
    while (queue.length) {
      const cur = queue.shift();
      const d = dist.get(cur);
      if (cur === vertexId) return d;
      for (const n of state.board.vertices[cur].adjacent) {
        if (!dist.has(n)) {
          dist.set(n, d + 1);
          queue.push(n);
        }
      }
    }
    return dist.get(vertexId) ?? Infinity;
  }
  const STRATEGIES = [
    {
      id: "road-expand",
      name: "Road & Expand",
      tagline: "Wood + brick: settle fast, take Longest Road",
      weights: { wood: 1.5, brick: 1.5, sheep: 0.9, wheat: 0.9, ore: 0.5 },
      buildOrder: ["road", "settlement", "road", "settlement", "city"]
    },
    {
      id: "city-dev",
      name: "Cities & Development",
      tagline: "Ore + wheat: cities, dev cards, Largest Army",
      weights: { wood: 0.5, brick: 0.5, sheep: 1, wheat: 1.5, ore: 1.6 },
      buildOrder: ["city", "dev", "city", "dev", "settlement"]
    },
    {
      id: "port-trade",
      name: "Port Monopoly",
      tagline: "Overload one abundant resource and trade through a 2:1 port",
      weights: { wood: 1, brick: 1, sheep: 1, wheat: 1, ore: 1 },
      buildOrder: ["settlement", "city", "settlement", "dev", "city"]
    },
    {
      id: "balanced",
      name: "Balanced",
      tagline: "No strong lean yet — take the highest-production spots and stay flexible",
      weights: { wood: 1, brick: 1, sheep: 1, wheat: 1, ore: 1 },
      buildOrder: ["settlement", "road", "city", "dev", "settlement"]
    }
  ];
  function rankStrategies(state, player) {
    const prod = playerProduction(state, player);
    const scarcity = scarcityWeights(state.board);
    const totalProd = RESOURCES.reduce((s, r) => s + prod[r], 0);
    const fits = STRATEGIES.map((strategy) => {
      const rationale = [];
      let alignment = 0;
      for (const r of RESOURCES) alignment += prod[r] * strategy.weights[r];
      const alignScore = alignment * 36;
      const spots = rankVertices(state, combineWeights(strategy.weights, scarcity), 3);
      const boardScore = spots.reduce((s, v) => s + v.score, 0) * 0.25;
      let score = alignScore + boardScore;
      if (strategy.id === "port-trade") {
        const ports = state.buildings.filter((b) => b.player === player).map((b) => state.board.vertices[b.vertexId].port).filter((p) => p !== null);
        const twoToOne = ports.find((p) => p.ratio === 2);
        if (twoToOne) {
          const feed = prod[twoToOne.kind] * 36;
          score += feed * 1.5;
          rationale.push(`You hold a 2:1 ${twoToOne.kind} port with ${feed.toFixed(0)} pips feeding it`);
        } else if (ports.length > 0) {
          score += 3;
          rationale.push("You hold a 3:1 port");
        } else {
          score *= 0.6;
          rationale.push("No port yet — grab one before committing to this");
        }
      }
      const keyRes = RESOURCES.filter((r) => strategy.weights[r] >= 1.4);
      if (keyRes.length > 0) {
        const keyProd = keyRes.reduce((s, r) => s + prod[r], 0) * 36;
        if (totalProd > 0 && keyProd >= totalProd * 36 * 0.45) {
          rationale.push(`Strong ${keyRes.join("+")} base (${keyProd.toFixed(0)} of your pips)`);
        } else if (totalProd > 0) {
          rationale.push(`Needs more ${keyRes.join("/")} than you currently produce`);
        }
      }
      if (spots.length > 0 && spots[0].score > 10) {
        rationale.push(`Board still has strong expansion spots for this plan`);
      }
      return { strategy, score, rationale };
    });
    return fits.sort((a, b) => b.score - a.score);
  }
  class BalancedDice {
    /**
     * discardAt > 0 mimics colonist.io: the deck reshuffles with a few cards
     * still unplayed, so counting cards never becomes fully deterministic.
     */
    constructor(rand, discardAt = 0) {
      __publicField(this, "deck", []);
      this.rand = rand;
      this.discardAt = discardAt;
    }
    refill() {
      this.deck = [];
      for (let d1 = 1; d1 <= 6; d1++) {
        for (let d2 = 1; d2 <= 6; d2++) this.deck.push(d1 + d2);
      }
      for (let i = this.deck.length - 1; i > 0; i--) {
        const j = Math.floor(this.rand() * (i + 1));
        [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
      }
    }
    roll() {
      if (this.deck.length <= this.discardAt) this.refill();
      return this.deck.pop();
    }
  }
  const COSTS$2 = {
    road: { wood: 1, brick: 1 },
    settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
    city: { ore: 3, wheat: 2 },
    dev: { ore: 1, sheep: 1, wheat: 1 }
  };
  function emptyHand$1() {
    return Object.fromEntries(RESOURCES.map((r) => [r, 0]));
  }
  function simulateStrategy(state, player, strategy, opts = {}) {
    const { rounds = 25, trials = 40, seed = 1 } = opts;
    const totals = { roads: 0, settlements: 0, cities: 0, devs: 0, vp: 0 };
    const scarcity = scarcityWeights(state.board);
    const weights = combineWeights(strategy.weights, scarcity);
    for (let t = 0; t < trials; t++) {
      const rand = mulberry32(seed + t * 7919);
      const dice = new BalancedDice(rand, 4);
      const hand = emptyHand$1();
      const sim = {
        board: state.board,
        buildings: state.buildings.map((b) => ({ ...b })),
        roads: state.roads.map((r) => ({ ...r }))
      };
      let reach = sim.roads.filter((r) => r.player === player).length;
      const built = { roads: 0, settlements: 0, cities: 0, devs: 0 };
      let orderIdx = 0;
      const bestRatio = (res) => {
        let ratio = 4;
        for (const b of sim.buildings) {
          if (b.player !== player) continue;
          const port = sim.board.vertices[b.vertexId].port;
          if (!port) continue;
          if (port.kind === "any") ratio = Math.min(ratio, 3);
          else if (port.kind === res) ratio = Math.min(ratio, 2);
        }
        return ratio;
      };
      const tryBuy = (item) => {
        const cost = COSTS$2[item];
        const missing = {};
        let missingTotal = 0;
        for (const r of RESOURCES) {
          const need = (cost[r] ?? 0) - hand[r];
          if (need > 0) {
            missing[r] = need;
            missingTotal += need;
          }
        }
        if (missingTotal > 0) {
          for (const give of RESOURCES) {
            if (missingTotal === 0) break;
            const surplus = hand[give] - (cost[give] ?? 0);
            const ratio = bestRatio(give);
            let tradeable = Math.floor(Math.max(0, surplus) / ratio);
            while (tradeable > 0 && missingTotal > 0) {
              const wanted = RESOURCES.find((r) => (missing[r] ?? 0) > 0);
              hand[give] -= ratio;
              hand[wanted] += 1;
              missing[wanted] -= 1;
              missingTotal -= 1;
              tradeable -= 1;
            }
          }
          for (const r of RESOURCES) if ((cost[r] ?? 0) > hand[r]) return false;
        }
        if (item === "settlement") {
          const spots = sim.board.vertices.filter((v) => isVertexBuildable(sim, v.id)).filter((v) => distanceFromPlayer(sim, player, v.id) <= Math.max(1, reach)).map((v) => scoreVertex(sim.board, v.id, weights)).sort((a, b) => b.score - a.score);
          if (spots.length === 0) return false;
          sim.buildings.push({ vertexId: spots[0].vertexId, player, kind: "settlement" });
          built.settlements++;
        } else if (item === "city") {
          const target = sim.buildings.find((b) => b.player === player && b.kind === "settlement");
          if (!target) return false;
          target.kind = "city";
          built.cities++;
        } else if (item === "road") {
          reach++;
          built.roads++;
        } else {
          built.devs++;
        }
        for (const r of RESOURCES) hand[r] -= COSTS$2[item][r] ?? 0;
        return true;
      };
      for (let round = 0; round < rounds; round++) {
        const roll = dice.roll();
        if (roll !== 7) {
          for (const b of sim.buildings) {
            if (b.player !== player) continue;
            const mult = b.kind === "city" ? 2 : 1;
            for (const hid of sim.board.vertices[b.vertexId].hexIds) {
              const h = sim.board.hexes[hid];
              if (h.kind !== "desert" && h.token === roll) hand[h.kind] += mult;
            }
          }
        } else {
          let count = RESOURCES.reduce((s, r) => s + hand[r], 0);
          if (count > 7) {
            let toDiscard = Math.floor(count / 2);
            while (toDiscard > 0) {
              const biggest = RESOURCES.reduce((a, b) => hand[a] >= hand[b] ? a : b);
              hand[biggest]--;
              toDiscard--;
            }
          }
        }
        const order = strategy.buildOrder;
        if (tryBuy(order[orderIdx % order.length])) {
          orderIdx++;
        } else {
          for (const alt of ["city", "settlement", "dev", "road"]) {
            if (alt !== order[orderIdx % order.length] && tryBuy(alt)) break;
          }
        }
      }
      totals.roads += built.roads;
      totals.settlements += built.settlements;
      totals.cities += built.cities;
      totals.devs += built.devs;
      totals.vp += built.settlements + built.cities + built.devs * 0.3 + (built.devs >= 5 ? 2 : 0);
    }
    return {
      strategy,
      meanVp: totals.vp / trials,
      meanBuilds: {
        roads: totals.roads / trials,
        settlements: totals.settlements / trials,
        cities: totals.cities / trials,
        devs: totals.devs / trials
      }
    };
  }
  function analyzeBoard(state) {
    const abundance = resourceAbundance(state.board);
    const scarcity = scarcityWeights(state.board);
    const sorted = [...RESOURCES].sort((a, b) => abundance[a] - abundance[b]);
    const scarcest = sorted[0];
    const richest = sorted[sorted.length - 1];
    const notes = [];
    notes.push(
      `${cap$1(richest)} is plentiful (${abundance[richest]} pips) — it will trade poorly, don't over-invest.`
    );
    notes.push(
      `${cap$1(scarcest)} is scarce (${abundance[scarcest]} pips) — corner it and everyone trades with you.`
    );
    const roadRes = abundance.wood + abundance.brick;
    const cityRes = abundance.ore + abundance.wheat;
    if (roadRes > cityRes + 4) {
      notes.push("Board favors road/settlement builds over city builds.");
    } else if (cityRes > roadRes + 4) {
      notes.push("Board favors ore+wheat city/dev-card play.");
    } else {
      notes.push("Road and city resources are evenly matched — placement decides it.");
    }
    return { abundance, scarcity, scarcest, richest, notes };
  }
  function advisePlayer(state, player) {
    const strategies = rankStrategies(state, player);
    const hasBuildings = buildingsOf(state, player).length > 0;
    const simulations = hasBuildings ? strategies.map(
      (f) => simulateStrategy(state, player, f.strategy, {
        rounds: 25,
        trials: 30,
        seed: state.board.seed + player
      })
    ) : [];
    let recommended = strategies[0];
    if (simulations.length > 0) {
      const maxFit = Math.max(...strategies.map((s) => s.score), 1);
      const maxVp = Math.max(...simulations.map((s) => s.meanVp), 0.1);
      let best = -Infinity;
      for (const fit of strategies) {
        const sim = simulations.find((s) => s.strategy.id === fit.strategy.id);
        const blended = 0.45 * (fit.score / maxFit) + 0.55 * (sim.meanVp / maxVp);
        if (blended > best) {
          best = blended;
          recommended = fit;
        }
      }
    }
    const scarcity = scarcityWeights(state.board);
    const weights = combineWeights(recommended.strategy.weights, scarcity);
    const expansion = state.board.vertices.filter((v) => isVertexBuildable(state, v.id)).map((v) => ({
      score: scoreVertex(state.board, v.id, weights),
      dist: distanceFromPlayer(state, player, v.id)
    })).filter((x) => x.dist <= 3).sort((a, b) => b.score.score - b.dist * 1.5 - (a.score.score - a.dist * 1.5)).slice(0, 3).map((x) => x.score);
    const trades = tradeTips$1(state, player, recommended);
    return { strategies, simulations, recommended, expansion, trades };
  }
  function tradeTips$1(state, player, fit) {
    const prod = playerProduction(state, player);
    const w = fit.strategy.weights;
    const tips = [];
    const surplus = [...RESOURCES].sort(
      (a, b) => prod[b] * (2 - w[b]) - prod[a] * (2 - w[a])
    )[0];
    const needed = [...RESOURCES].sort(
      (a, b) => w[b] * (1 - Math.min(1, prod[b] * 12)) - w[a] * (1 - Math.min(1, prod[a] * 12))
    )[0];
    if (surplus && needed && surplus !== needed && prod[surplus] > 0) {
      tips.push({
        give: surplus,
        get: needed,
        reason: `${cap$1(surplus)} is your most expendable income; ${cap$1(needed)} is the bottleneck for ${fit.strategy.name}.`
      });
    }
    const scarcest = analyzeBoard(state).scarcest;
    if (prod[scarcest] > 0.08) {
      tips.push({
        give: scarcest,
        get: needed === scarcest ? surplus : needed,
        reason: `You produce scarce ${scarcest} — demand steep prices (2:1 or better) from other players.`
      });
    }
    return tips;
  }
  function cap$1(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  const COLONIST_COLORS = {
    1: "#E27174",
    2: "#223697",
    3: "#E09742",
    4: "#62B95D",
    5: "#9B6EA9",
    6: "#F5D442",
    7: "#5FB3B3",
    8: "#8B5A2B"
  };
  function colonistIdForColor(color) {
    const want = color.toLowerCase();
    for (const [id, c] of Object.entries(COLONIST_COLORS)) {
      if (c.toLowerCase() === want) return Number(id);
    }
    return null;
  }
  function spotContest(state, youPlayer, vertexId) {
    const ourPath = roadPathTo(state, youPlayer, vertexId);
    const ourLen = ourPath.length;
    const opponents = new Set(
      state.buildings.map((b) => b.player).filter((p) => p !== youPlayer)
    );
    let oppLen = null;
    for (const op of opponents) {
      const path = roadPathTo(state, op, vertexId);
      if (path.length === 0) continue;
      if (oppLen === null || path.length < oppLen) oppLen = path.length;
    }
    if (oppLen === null || ourPath.length === 0) {
      return { losing: false, tied: false, ourLen, oppLen };
    }
    return { losing: oppLen < ourLen, tied: oppLen === ourLen, ourLen, oppLen };
  }
  function describeVertex(state, vertexId) {
    const v = state.board.vertices[vertexId];
    const parts = v.hexIds.map((hid) => state.board.hexes[hid]).filter((h) => h.kind !== "desert" && h.token !== null).sort((a, b) => pips(b.token) - pips(a.token)).map((h) => `${h.token}-${h.kind}`);
    const total2 = vertexPips(state.board, vertexId);
    const port = v.port ? v.port.ratio === 2 ? `, 2:1 ${v.port.kind} port` : ", 3:1 port" : "";
    return `${parts.join(" + ") || "coastal"} (${total2} pips${port})`;
  }
  function roadPathTo(state, player, target, fromVertices) {
    const sources = /* @__PURE__ */ new Set();
    if (fromVertices) {
      for (const v of fromVertices) sources.add(v);
    } else {
      for (const b of state.buildings) if (b.player === player) sources.add(b.vertexId);
      for (const r of state.roads) {
        if (r.player === player) {
          const e = state.board.edges[r.edgeId];
          sources.add(e.a);
          sources.add(e.b);
        }
      }
    }
    if (sources.size === 0) return [];
    const blocked = new Set(
      state.buildings.filter((b) => b.player !== player).map((b) => b.vertexId)
    );
    const takenEdges = new Set(state.roads.map((r) => r.edgeId));
    const prev = /* @__PURE__ */ new Map();
    const queue = [...sources].filter((v) => !blocked.has(v));
    const seen = new Set(queue);
    while (queue.length) {
      const cur2 = queue.shift();
      if (cur2 === target) break;
      if (blocked.has(cur2)) continue;
      for (const n of state.board.vertices[cur2].adjacent) {
        if (seen.has(n)) continue;
        const edge = state.board.edges.find(
          (e) => e.a === cur2 && e.b === n || e.a === n && e.b === cur2
        );
        if (!edge || takenEdges.has(edge.id)) continue;
        seen.add(n);
        prev.set(n, { vertex: cur2, edge: edge.id });
        queue.push(n);
      }
    }
    if (!seen.has(target)) return [];
    const path = [];
    let cur = target;
    while (prev.has(cur)) {
      const p = prev.get(cur);
      path.unshift(p.edge);
      cur = p.vertex;
    }
    return path;
  }
  function placementWeights(board) {
    const scarcity = scarcityWeights(board);
    const out = {};
    for (const r of RESOURCES) out[r] = 1 + 0.4 * (scarcity[r] - 1);
    return out;
  }
  const SETUP_NEED = { wheat: 1, ore: 1, wood: 1, brick: 1, sheep: 1 };
  function startingResourcesFor(state, vertexId) {
    const out = Object.fromEntries(RESOURCES.map((r) => [r, 0]));
    for (const hid of state.board.vertices[vertexId].hexIds) {
      const h = state.board.hexes[hid];
      if (h.kind !== "desert") out[h.kind] += 1;
    }
    return out;
  }
  function rankSetupSpots(state, youPlayer, weights, limit = 3) {
    const existing = playerProduction(state, youPlayer);
    const netPipsByToken = /* @__PURE__ */ new Map();
    const haveBuildings = state.buildings.some((b) => b.player === youPlayer);
    for (const b of state.buildings) {
      if (b.player !== youPlayer) continue;
      for (const hid of state.board.vertices[b.vertexId].hexIds) {
        const h = state.board.hexes[hid];
        if (h.kind === "desert" || h.token === null) continue;
        netPipsByToken.set(h.token, (netPipsByToken.get(h.token) ?? 0) + pips(h.token));
      }
    }
    const scored = state.board.vertices.filter((v) => isVertexBuildable(state, v.id)).map((v) => {
      const base = scoreVertex(state.board, v.id, weights);
      const add = {};
      const addByToken = /* @__PURE__ */ new Map();
      for (const hid of v.hexIds) {
        const h = state.board.hexes[hid];
        if (h.kind === "desert" || h.token === null) continue;
        add[h.kind] = (add[h.kind] ?? 0) + pips(h.token);
        addByToken.set(h.token, (addByToken.get(h.token) ?? 0) + pips(h.token));
      }
      let utility = 0;
      for (const r of RESOURCES) {
        const have = existing[r] * 36;
        const more = add[r] ?? 0;
        utility += weights[r] * SETUP_NEED[r] * (Math.sqrt(have + more) - Math.sqrt(have));
      }
      const covers = RESOURCES.filter((r) => (add[r] ?? 0) > 0 && existing[r] === 0);
      const coverageBonus = covers.reduce((acc, r) => acc + (r === "sheep" ? 1 : 2.5), 0);
      let score = utility * 3 + base.pips * 0.5 + coverageBonus;
      const notes = [...base.notes];
      if (haveBuildings && addByToken.size > 0) {
        const merged = new Map(netPipsByToken);
        let total2 = 0;
        for (const n of merged.values()) total2 += n;
        for (const [tok, n] of addByToken) {
          merged.set(tok, (merged.get(tok) ?? 0) + n);
          total2 += n;
        }
        let topShare = 0;
        let topToken = 0;
        for (const [tok, n] of merged) {
          if (n / total2 > topShare) {
            topShare = n / total2;
            topToken = tok;
          }
        }
        if (topShare > 0.55) {
          const penalty = (topShare - 0.55) * 12;
          score -= penalty;
          notes.push(`correlated income: ${(topShare * 100).toFixed(0)}% of pips on the ${topToken}`);
        }
      }
      const allHexPips = /* @__PURE__ */ new Map();
      for (const b of state.buildings.filter((b2) => b2.player === youPlayer)) for (const hid of state.board.vertices[b.vertexId].hexIds) {
        allHexPips.set(hid, (allHexPips.get(hid) ?? 0) + pips(state.board.hexes[hid].token));
      }
      let repeated = 0;
      for (const hid of v.hexIds) if (allHexPips.has(hid)) repeated += pips(state.board.hexes[hid].token);
      score -= repeated * 0.3;
      if (haveBuildings) {
        const rate = Object.fromEntries(RESOURCES.map((r) => [r, (existing[r] + (add[r] ?? 0) / 36) * 2]));
        const payout = startingResourcesFor(state, v.id);
        const wait = Math.min(
          turnsToAfford(BUILD.city, payout, rate),
          turnsToAfford({ wood: 2, brick: 2, sheep: 1, wheat: 1 }, payout, rate)
        );
        score += 3 / (1 + wait);
      }
      if (covers.length && state.buildings.some((b) => b.player === youPlayer)) notes.push(`adds ${covers.join("+")} you lack`);
      return { ...base, score, notes };
    }).sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }
  function opponentDistance(state, you, target) {
    const opps = /* @__PURE__ */ new Set();
    for (const b of state.buildings) if (b.player !== you) opps.add(b.player);
    for (const r of state.roads) if (r.player !== you) opps.add(r.player);
    let best = Infinity;
    for (const opp of opps) {
      const from = /* @__PURE__ */ new Set();
      for (const b of state.buildings) if (b.player === opp) from.add(b.vertexId);
      for (const r of state.roads) {
        if (r.player === opp) {
          const e = state.board.edges[r.edgeId];
          from.add(e.a);
          from.add(e.b);
        }
      }
      if (from.has(target)) return 0;
      const path = roadPathTo(state, opp, target, [...from]);
      if (path.length > 0) best = Math.min(best, path.length);
    }
    return best;
  }
  function isContested(state, you, target, ourDist) {
    return opponentDistance(state, you, target) <= ourDist;
  }
  function advisePlacement(state, youPlayer, playerCount = 2) {
    if (youPlayer === null) {
      const top = rankVertices(state, placementWeights(state.board), 3);
      return {
        phase: "setup",
        heading: "Best open spots",
        spots: top.map((s, i) => ({
          vertexId: s.vertexId,
          rank: i + 1,
          label: describeVertex(state, s.vertexId)
        })),
        roadEdges: [],
        note: null
      };
    }
    const yourBuildings = state.buildings.filter((b) => b.player === youPlayer);
    const yourRoads = state.roads.filter((r) => r.player === youPlayer);
    const setup = yourBuildings.length < 2 && state.buildings.length < 8;
    if (yourBuildings.length > yourRoads.length && (setup || yourBuildings.length <= 2)) {
      return adviseSetupRoad(state, youPlayer, yourBuildings, yourRoads);
    }
    if (setup) {
      const base = placementWeights(state.board);
      let note2 = null;
      if (yourBuildings.length === 1) {
        const covered = new Set(
          state.board.vertices[yourBuildings[0].vertexId].hexIds.map((h) => state.board.hexes[h].kind).filter((k) => k !== "desert")
        );
        const missing = RESOURCES.filter((r) => !covered.has(r));
        if (missing.length) note2 = `Your first spot lacks ${missing.join(", ")} — these picks weigh that heavily.`;
      }
      const top = rankSetupSpots(state, youPlayer, base, 3);
      const mineCount = yourBuildings.length;
      const oppCount = state.buildings.length - mineCount;
      if (playerCount === 2 && mineCount === 0 && oppCount === 1) {
        const pool2 = rankSetupSpots(state, youPlayer, base, Infinity);
        let bestPair = null;
        for (const first of pool2) {
          const trial = { ...state, buildings: [
            ...state.buildings,
            { player: youPlayer, vertexId: first.vertexId, kind: "settlement" }
          ] };
          const seconds = rankSetupSpots(trial, youPlayer, base, Infinity);
          for (const second of seconds) {
            const combined = first.score + second.score;
            if (!bestPair || combined > bestPair.score) bestPair = { first, second, score: combined };
          }
        }
        if (bestPair) {
          const nowSpot = bestPair.first;
          const paySpot = bestPair.second;
          return {
            phase: "setup",
            heading: "You place TWICE in a row — plan the pair",
            spots: [
              {
                vertexId: nowSpot.vertexId,
                rank: 1,
                label: `${describeVertex(state, nowSpot.vertexId)} — place NOW (this one won't collect resources)`
              },
              {
                vertexId: paySpot.vertexId,
                rank: 2,
                label: `${describeVertex(state, paySpot.vertexId)} — place SECOND (this one pays the starting hand)`
              }
            ],
            roadEdges: [],
            note: "Going second, your two placements are back-to-back — nothing can be taken in between. Both spots are legal together; the second payout accelerates the first productive build."
          };
        }
      }
      if (mineCount === 1 && oppCount === 1) {
        note2 = `${note2 ? note2 + " " : ""}This placement COLLECTS the starting resources — weight wood/brick/wheat adjacency.`;
      }
      return {
        phase: "setup",
        heading: yourBuildings.length === 0 ? "Place your 1st settlement here" : "Place your 2nd settlement here",
        spots: top.map((s, i) => ({
          vertexId: s.vertexId,
          rank: i + 1,
          label: describeVertex(state, s.vertexId)
        })),
        roadEdges: [],
        note: note2
      };
    }
    const advice = advisePlayer(state, youPlayer);
    const expWeights = combineWeights(advice.recommended.strategy.weights, placementWeights(state.board));
    const ranked = rankSetupSpots(state, youPlayer, expWeights, 14).map((s) => {
      const dist = roadPathTo(state, youPlayer, s.vertexId).length;
      const contested = dist > 0 && isContested(state, youPlayer, s.vertexId, dist);
      return { s, dist, contested, value: s.score - dist * 1.5 - (contested ? 3.5 : 0) };
    }).filter((x) => x.dist > 0 && x.dist <= 4).sort((a, b) => b.value - a.value);
    const near = ranked.filter((x) => x.dist <= 3);
    const pool = near.length > 0 ? near : ranked;
    const spots = pool.slice(0, 3).map((x, i) => ({
      vertexId: x.s.vertexId,
      rank: i + 1,
      label: `${describeVertex(state, x.s.vertexId)}${x.contested ? " — contested" : ""}`
    }));
    let roadEdges = [];
    let roadPathLength = 0;
    let note = null;
    let race;
    if (spots.length > 0) {
      const path = roadPathTo(state, youPlayer, spots[0].vertexId);
      roadEdges = path.slice(0, 2);
      roadPathLength = path.length;
      if (path.length > 0) {
        note = `${path.length} road${path.length > 1 ? "s" : ""} to reach spot ①${path.length > 2 ? " — dashed segments are the next two" : ""}.`;
      }
      for (const s of spots) {
        const c = spotContest(state, youPlayer, s.vertexId);
        if (c.oppLen !== null && c.ourLen > 0 && (c.losing || c.tied)) {
          const gap = c.ourLen - (c.oppLen ?? 0);
          s.label += c.losing ? ` ⚠ race LOST by ${gap} road${gap === 1 ? "" : "s"} — they get there first` : ` ⚠ tied race (${c.oppLen} roads each) — risky to commit`;
        }
      }
      const c0 = spotContest(state, youPlayer, spots[0].vertexId);
      if (c0.oppLen !== null) {
        race = { losing: c0.losing, tied: c0.tied, ourLen: c0.ourLen, oppLen: c0.oppLen };
        if ((c0.losing || c0.tied) && c0.ourLen > 0) {
          note = `${note ? note + " " : ""}⚠ Spot ① is contested: opponent needs ${c0.oppLen} road${c0.oppLen === 1 ? "" : "s"} vs our ${c0.ourLen}.`;
        }
      }
    }
    return {
      phase: "main",
      heading: `Expand toward (${advice.recommended.strategy.name})`,
      spots,
      roadEdges,
      roadPathLength,
      note,
      race
    };
  }
  function adviseSetupRoad(state, youPlayer, yourBuildings, yourRoads) {
    const pending = yourBuildings.find((b) => {
      return !yourRoads.some((r) => {
        const e = state.board.edges[r.edgeId];
        return e.a === b.vertexId || e.b === b.vertexId;
      });
    }) ?? yourBuildings[yourBuildings.length - 1];
    const weights = placementWeights(state.board);
    const scored = rankVertices(state, weights, 12).map((s) => {
      const path = roadPathTo(state, youPlayer, s.vertexId, [pending.vertexId]);
      const oppDist = opponentDistance(state, youPlayer, s.vertexId);
      const contested = oppDist <= path.length;
      const raw = s.score - path.length * 1.5;
      const factor = !contested ? 1 : path.length === 1 ? 0.6 : oppDist < path.length ? 0.25 : 0.5;
      return { s, path, oppDist, contested, value: raw * factor };
    }).filter((c) => c.path.length > 0 && c.path.length <= 4);
    const byEdge = /* @__PURE__ */ new Map();
    for (const c of scored) {
      const list = byEdge.get(c.path[0]) ?? [];
      list.push(c);
      byEdge.set(c.path[0], list);
    }
    let bestEdge = null;
    for (const [edge, list] of byEdge) {
      list.sort((a, b) => b.value - a.value);
      const value = list[0].value + 0.35 * list.slice(1).reduce((acc, c) => acc + Math.max(0, c.value), 0);
      if (!bestEdge || value > bestEdge.value) bestEdge = { edge, list, value };
    }
    const candidates = bestEdge ? bestEdge.list : [];
    const skipped = scored.filter((c) => {
      var _a;
      return c.contested && c !== candidates[0] && c.s.score > (((_a = candidates[0]) == null ? void 0 : _a.s.score) ?? -Infinity);
    }).sort((a, b) => b.s.score - a.s.score)[0];
    if (candidates.length === 0) {
      return {
        phase: "setup",
        heading: "Place your road",
        spots: [],
        roadEdges: [],
        note: "No strong expansion direction — any coastal-facing road is fine."
      };
    }
    const best = candidates[0];
    return {
      phase: "setup",
      heading: "Place your road here (dashed)",
      spots: candidates.slice(0, 2).map((c, i) => ({
        vertexId: c.s.vertexId,
        rank: i + 1,
        label: `${describeVertex(state, c.s.vertexId)} — ${c.path.length} road${c.path.length > 1 ? "s" : ""} away${c.contested ? " (contested)" : ""}`
      })),
      roadEdges: [best.path[0]],
      note: skipped ? `The dashed edge points toward ①. Skipped ${describeVertex(state, skipped.s.vertexId)}: an opponent is ${skipped.oppDist} road${skipped.oppDist === 1 ? "" : "s"} from it — a race we'd likely lose.` : "The dashed edge points toward your best future settlement ①."
    };
  }
  function placementFacts(state, youPlayer, advice) {
    var _a;
    const network = /* @__PURE__ */ new Set();
    for (const b of state.buildings) if (b.player === youPlayer) network.add(b.vertexId);
    for (const r of state.roads) {
      if (r.player === youPlayer) {
        const e = state.board.edges[r.edgeId];
        network.add(e.a);
        network.add(e.b);
      }
    }
    const canPlaceSettlement = [...network].some((v) => isVertexBuildable(state, v));
    const yourSettlements = state.buildings.filter(
      (b) => b.player === youPlayer && b.kind === "settlement"
    );
    let cityUpgradeLabel = null;
    if (yourSettlements.length > 0) {
      const best = yourSettlements.reduce(
        (a, b) => vertexPips(state.board, a.vertexId) >= vertexPips(state.board, b.vertexId) ? a : b
      );
      cityUpgradeLabel = describeVertex(state, best.vertexId);
    }
    return {
      canPlaceSettlement,
      bestSpotLabel: ((_a = advice == null ? void 0 : advice.spots[0]) == null ? void 0 : _a.label) ?? null,
      hasRoadSuggestion: ((advice == null ? void 0 : advice.roadEdges.length) ?? 0) > 0,
      cityUpgradeLabel
    };
  }
  const TILE_FILL = {
    brick: "var(--brick)",
    wheat: "var(--wheat)",
    sheep: "var(--sheep)",
    ore: "var(--ore)",
    wood: "var(--wood)",
    desert: "var(--desert, #d8cba0)"
  };
  function renderMiniMap(state, marks) {
    const b = state.board;
    const S = 26;
    const xs = b.vertices.map((v) => v.x);
    const ys = b.vertices.map((v) => v.y);
    const minX = Math.min(...xs) - 0.5;
    const minY = Math.min(...ys) - 0.5;
    const w = Math.max(...xs) - minX + 0.5;
    const h = Math.max(...ys) - minY + 0.5;
    const px = (x) => ((x - minX) * S).toFixed(1);
    const py = (y) => ((y - minY) * S).toFixed(1);
    const parts = [];
    parts.push(
      `<svg viewBox="0 0 ${(w * S).toFixed(0)} ${(h * S).toFixed(0)}" style="width:100%;display:block" role="img" aria-label="board map with recommended placements">`
    );
    for (const hex of b.hexes) {
      const pts = hexCornerPoints(hex).map((p) => `${px(p.x)},${py(p.y)}`).join(" ");
      parts.push(`<polygon points="${pts}" fill="${TILE_FILL[hex.kind]}" stroke="var(--surface)" stroke-width="1.5" opacity="0.85"/>`);
      if (hex.token !== null) {
        const hot = hex.token === 6 || hex.token === 8;
        parts.push(
          `<circle cx="${px(hex.cx)}" cy="${py(hex.cy)}" r="7.5" fill="var(--surface)"/><text x="${px(hex.cx)}" y="${py(hex.cy)}" text-anchor="middle" dominant-baseline="central" font-size="9" font-weight="${hot ? 700 : 500}" fill="${hot ? "var(--brick)" : "var(--ink)"}">${hex.token}</text>`
        );
      }
    }
    for (const v of b.vertices) {
      if (v.port) {
        const label = v.port.ratio === 2 ? `2:1` : `3:1`;
        parts.push(
          `<text x="${px(v.x)}" y="${py(v.y)}" text-anchor="middle" dominant-baseline="central" font-size="5.5" fill="var(--ink-3)">${label}</text>`
        );
      }
    }
    for (const r of marks.roads) {
      const e = b.edges[r.edgeId];
      parts.push(
        `<line x1="${px(b.vertices[e.a].x)}" y1="${py(b.vertices[e.a].y)}" x2="${px(b.vertices[e.b].x)}" y2="${py(b.vertices[e.b].y)}" stroke="${COLONIST_COLORS[r.colorId] ?? "#888"}" stroke-width="3" stroke-linecap="round"/>`
      );
    }
    for (const edgeId of marks.roadEdges) {
      const e = b.edges[edgeId];
      parts.push(
        `<line x1="${px(b.vertices[e.a].x)}" y1="${py(b.vertices[e.a].y)}" x2="${px(b.vertices[e.b].x)}" y2="${py(b.vertices[e.b].y)}" stroke="var(--gold, #b8860b)" stroke-width="3.5" stroke-dasharray="4 3" stroke-linecap="round"/>`
      );
    }
    for (const bd of marks.buildings) {
      const v = b.vertices[bd.vertexId];
      const c = COLONIST_COLORS[bd.colorId] ?? "#888";
      if (bd.kind === "city") {
        parts.push(`<rect x="${(parseFloat(px(v.x)) - 4.5).toFixed(1)}" y="${(parseFloat(py(v.y)) - 4.5).toFixed(1)}" width="9" height="9" fill="${c}" stroke="var(--surface)" stroke-width="1.2"/>`);
      } else {
        parts.push(`<circle cx="${px(v.x)}" cy="${py(v.y)}" r="4" fill="${c}" stroke="var(--surface)" stroke-width="1.2"/>`);
      }
    }
    for (const s of marks.spots) {
      const v = b.vertices[s.vertexId];
      parts.push(
        `<circle cx="${px(v.x)}" cy="${py(v.y)}" r="7" fill="var(--gold, #b8860b)" stroke="var(--surface)" stroke-width="1.5"/><text x="${px(v.x)}" y="${py(v.y)}" text-anchor="middle" dominant-baseline="central" font-size="8.5" font-weight="700" fill="#fff">${s.rank}</text>`
      );
    }
    parts.push("</svg>");
    return parts.join("");
  }
  const DECK_CYCLE = 32;
  function createTracker(youName) {
    return {
      players: /* @__PURE__ */ new Map(),
      youName,
      rolls: [],
      rollsThisDeck: [],
      lastRoll: null,
      gameOver: false,
      discardLimit: 9
    };
  }
  function emptyHand() {
    return Object.fromEntries(RESOURCES.map((r) => [r, 0]));
  }
  function getPlayer(state, name, color = "#888", playerId = null) {
    let p = state.players.get(name);
    if (!p) {
      p = {
        name,
        color,
        playerId,
        hand: emptyHand(),
        uncertainty: 0,
        trackingHealth: "incomplete",
        settlements: 0,
        cities: 0,
        roads: 0,
        devCards: 0,
        knightsPlayed: 0,
        incomeByNumber: /* @__PURE__ */ new Map(),
        bankRatio: {},
        serverCards: null,
        serverVp: null
      };
      state.players.set(name, p);
    }
    if (color !== "#888") p.color = color;
    if (playerId !== null) p.playerId = playerId;
    return p;
  }
  function applyDelta(p, delta) {
    for (const [res, n] of Object.entries(delta)) {
      const r = res;
      const next = p.hand[r] + (n ?? 0);
      if (next < 0) {
        p.uncertainty += -next;
        p.hand[r] = 0;
      } else {
        p.hand[r] = next;
      }
    }
  }
  const COSTS$1 = {
    road: { wood: -1, brick: -1 },
    settlement: { wood: -1, brick: -1, sheep: -1, wheat: -1 },
    city: { ore: -3, wheat: -2 },
    dev: { ore: -1, sheep: -1, wheat: -1 }
  };
  function resolveYou(state, name) {
    return name ?? state.youName;
  }
  function applyEvent(state, ev) {
    switch (ev.type) {
      case "ignored":
        break;
      case "game-over":
        state.gameOver = ev.winner;
        break;
      case "roll": {
        getPlayer(state, ev.player);
        state.rolls.push(ev.total);
        const full = ev.total === 7 ? 6 : pips(ev.total);
        const seen = state.rollsThisDeck.filter((t) => t === ev.total).length;
        if (seen >= full) state.rollsThisDeck = [];
        state.rollsThisDeck.push(ev.total);
        if (state.rollsThisDeck.length >= DECK_CYCLE) state.rollsThisDeck = [];
        state.lastRoll = { player: ev.player, total: ev.total };
        break;
      }
      case "got": {
        const p = getPlayer(state, ev.player);
        applyDelta(p, ev.resources);
        if (state.lastRoll) {
          p.incomeByNumber.set(state.lastRoll.total, { ...ev.resources });
        }
        break;
      }
      case "starting-resources": {
        const p = getPlayer(state, ev.player);
        applyDelta(p, ev.resources);
        break;
      }
      case "place": {
        const p = getPlayer(state, ev.player, ev.color);
        if (ev.what === "settlement") p.settlements++;
        if (ev.what === "city") p.cities++;
        if (ev.what === "road") p.roads++;
        break;
      }
      case "build": {
        const p = getPlayer(state, ev.player);
        applyDelta(p, COSTS$1[ev.what]);
        if (ev.what === "settlement") p.settlements++;
        if (ev.what === "road") p.roads++;
        if (ev.what === "city") {
          p.cities++;
          p.settlements = Math.max(0, p.settlements - 1);
        }
        break;
      }
      case "buy-dev": {
        const p = getPlayer(state, ev.player);
        applyDelta(p, COSTS$1.dev);
        p.devCards++;
        break;
      }
      case "bank-trade": {
        const p = getPlayer(state, ev.player);
        const gaveEntries = Object.entries(ev.delta).filter(([, v]) => (v ?? 0) < 0);
        if (gaveEntries.length === 1 && ev.took === 1) {
          const [res, v] = gaveEntries[0];
          const ratio = -(v ?? 0);
          const r = res;
          p.bankRatio[r] = Math.min(p.bankRatio[r] ?? 4, ratio);
        }
        applyDelta(p, ev.delta);
        break;
      }
      case "player-trade": {
        const p = getPlayer(state, ev.player);
        applyDelta(p, ev.delta);
        if (ev.partner) {
          const partner = getPlayer(state, ev.partner);
          const inverse = {};
          for (const [r, v] of Object.entries(ev.delta)) {
            inverse[r] = -(v ?? 0);
          }
          applyDelta(partner, inverse);
        }
        break;
      }
      case "steal-known": {
        const thief = resolveYou(state, ev.thief);
        const victim = resolveYou(state, ev.victim);
        if (thief) applyDelta(getPlayer(state, thief), { [ev.resource]: 1 });
        if (victim) applyDelta(getPlayer(state, victim), { [ev.resource]: -1 });
        break;
      }
      case "steal-unknown": {
        const thief = resolveYou(state, ev.thief);
        const victim = resolveYou(state, ev.victim);
        if (thief) getPlayer(state, thief).uncertainty++;
        if (victim) {
          const v = getPlayer(state, victim);
          v.uncertainty++;
          v.trackingHealth = "repairing";
        }
        break;
      }
      case "monopoly-steal": {
        const p = getPlayer(state, ev.player);
        applyDelta(p, { [ev.resource]: ev.count });
        for (const other of state.players.values()) {
          if (other.name !== ev.player) other.hand[ev.resource] = 0;
        }
        break;
      }
      case "take-from-bank": {
        applyDelta(getPlayer(state, ev.player), ev.resources);
        break;
      }
      case "discard": {
        const p = getPlayer(state, ev.player);
        const inverse = {};
        for (const [r, v] of Object.entries(ev.resources)) {
          inverse[r] = -(v ?? 0);
        }
        applyDelta(p, inverse);
        break;
      }
      case "use-knight": {
        const p = getPlayer(state, ev.player);
        p.knightsPlayed++;
        p.devCards = Math.max(0, p.devCards - 1);
        break;
      }
      case "use-dev": {
        const p = getPlayer(state, ev.player);
        p.devCards = Math.max(0, p.devCards - 1);
        break;
      }
    }
  }
  function ensurePlayer(state, name, color = "#888") {
    getPlayer(state, name, color);
  }
  const RESOURCE_TO_CARD_ID = {
    wood: 1,
    brick: 2,
    sheep: 3,
    wheat: 4,
    ore: 5
  };
  function handTotal(p) {
    return RESOURCES.reduce((s, r) => s + p.hand[r], 0);
  }
  function reconcileHandWithTotal(p) {
    if (p.serverCards === null) return;
    const mismatch = Math.abs(p.serverCards - handTotal(p));
    if (mismatch > 0) {
      p.uncertainty = Math.max(p.uncertainty, mismatch);
      p.trackingHealth = "repairing";
      p.trackingReason = "Resource ledger and server total disagree";
    }
  }
  function visibleVp(p) {
    return p.serverVp ?? p.settlements + p.cities * 2;
  }
  function inferOpponentDevCards(opponent, robberHex, _state, board, allBuildings) {
    const unplayedCount = Math.max(0, opponent.devCards - opponent.knightsPlayed);
    const reasoning = [];
    let likelyMonopoly = false;
    let likelyKnight = false;
    let likelyRoadBuilding = false;
    let likelyYearOfPlenty = false;
    let likelyVpCard = false;
    let confidence = 0.3;
    if (robberHex && board && allBuildings && unplayedCount > 0) {
      const oppId = opponent.playerId ?? colonistIdForColor(opponent.color);
      const oppBuildings = oppId === null ? [] : allBuildings.filter((b) => b.player === oppId);
      const blocked = oppBuildings.some(
        (b) => board.vertices[b.vertexId].hexIds.some(
          (hId) => {
            const h = board.hexes[hId];
            return h.q === robberHex.x && h.r === robberHex.y;
          }
        )
      );
      if (blocked) {
        likelyKnight = false;
        likelyMonopoly = true;
        confidence += 0.2;
        reasoning.push("Robber blocks them but no knight played → likely monopoly/YoP/VP");
      } else {
        likelyKnight = true;
        confidence += 0.1;
        reasoning.push("Not blocked → could have knight");
      }
    }
    const oppVp = visibleVp(opponent);
    if (oppVp >= 8 && unplayedCount > 0) {
      likelyVpCard = true;
      confidence += 0.3;
      reasoning.push(`${oppVp} VP with ${unplayedCount} unplayed dev → likely VP card(s)`);
    }
    if (unplayedCount >= 3 && oppVp < 8) {
      likelyMonopoly = true;
      likelyYearOfPlenty = true;
      likelyRoadBuilding = true;
      confidence += 0.2;
      reasoning.push(`${unplayedCount} unplayed dev cards → monopoly/YoP/road building likely`);
    }
    if (unplayedCount > 0 && !likelyKnight && !likelyMonopoly) {
      likelyMonopoly = true;
      likelyYearOfPlenty = true;
      confidence += 0.1;
      reasoning.push("Unplayed dev cards, not blocked → monopoly/YoP likely");
    }
    return {
      likelyMonopoly,
      likelyKnight,
      likelyRoadBuilding,
      likelyYearOfPlenty,
      likelyVpCard,
      unplayedCount,
      confidence: Math.min(1, confidence),
      reasoning
    };
  }
  const SHOE_REFILL_BELOW = 5;
  function deckStatus(state) {
    const full = /* @__PURE__ */ new Map();
    const remaining = /* @__PURE__ */ new Map();
    for (let n = 2; n <= 12; n++) {
      full.set(n, n === 7 ? 6 : pips(n));
      remaining.set(n, n === 7 ? 6 : pips(n));
    }
    for (const roll of state.rollsThisDeck) {
      remaining.set(roll, Math.max(0, (remaining.get(roll) ?? 0) - 1));
    }
    let totalRemaining = [...remaining.values()].reduce((a, b) => a + b, 0);
    if (totalRemaining <= SHOE_REFILL_BELOW) {
      for (let n = 2; n <= 12; n++) remaining.set(n, full.get(n));
      totalRemaining = 36;
    }
    const prob = /* @__PURE__ */ new Map();
    const due = [];
    const cold = [];
    for (let n = 2; n <= 12; n++) {
      const base = (n === 7 ? 6 : pips(n)) / 36;
      const p = totalRemaining > 0 ? (remaining.get(n) ?? 0) / totalRemaining : base;
      prob.set(n, p);
      if (p >= base * 1.35 && (remaining.get(n) ?? 0) > 0) due.push(n);
      if ((remaining.get(n) ?? 0) === 0) cold.push(n);
    }
    return { remaining, totalRemaining, prob, due, cold, rollsIntoDeck: state.rollsThisDeck.length };
  }
  function expectedProduction(p, probOf) {
    const out = Object.fromEntries(RESOURCES.map((r) => [r, 0]));
    for (const [n, delta] of p.incomeByNumber) {
      const prob = pips(n) / 36;
      for (const [res, count] of Object.entries(delta)) {
        out[res] += prob * (count ?? 0);
      }
    }
    return out;
  }
  function productionTotal(prod) {
    return RESOURCES.reduce((s, r) => s + prod[r], 0);
  }
  const BUILD_COSTS$1 = {
    road: { wood: 1, brick: 1 },
    settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
    city: { ore: 3, wheat: 2 },
    dev: { ore: 1, sheep: 1, wheat: 1 }
  };
  function simulateLive(p, strategy, seed, discardLimit = 9, rounds = 25, trials = 30) {
    const buildingCount = Math.max(1, p.settlements + p.cities);
    const baseProd = expectedProduction(p);
    const perBuilding = productionTotal(baseProd) / buildingCount;
    const mixTotal = productionTotal(baseProd) || 1;
    let vpSum = 0;
    for (let t = 0; t < trials; t++) {
      const rand = mulberry32(seed + t * 104729);
      const dice = new BalancedDice(rand, 4);
      const hand = { ...p.hand };
      let extraBuildings = 0;
      let orderIdx = 0;
      const built = { settlements: 0, cities: 0, devs: 0, roads: 0 };
      const ratioFor = (res) => p.bankRatio[res] ?? 4;
      const tryBuy = (item) => {
        const cost = BUILD_COSTS$1[item];
        let missing = 0;
        const need = {};
        for (const r of RESOURCES) {
          const gap = (cost[r] ?? 0) - hand[r];
          if (gap > 0) {
            need[r] = gap;
            missing += gap;
          }
        }
        if (missing > 0) {
          for (const give of RESOURCES) {
            if (missing === 0) break;
            const ratio = ratioFor(give);
            let spare = Math.floor(Math.max(0, hand[give] - (cost[give] ?? 0)) / ratio);
            while (spare > 0 && missing > 0) {
              const wanted = RESOURCES.find((r) => (need[r] ?? 0) > 0);
              hand[give] -= ratio;
              hand[wanted] += 1;
              need[wanted] -= 1;
              missing--;
              spare--;
            }
          }
          for (const r of RESOURCES) if ((cost[r] ?? 0) > hand[r]) return false;
        }
        for (const r of RESOURCES) hand[r] -= cost[r] ?? 0;
        if (item === "settlement") {
          built.settlements++;
          extraBuildings++;
        } else if (item === "city") {
          if (p.settlements + built.settlements === 0) return false;
          built.cities++;
          extraBuildings++;
        } else if (item === "dev") built.devs++;
        else built.roads++;
        return true;
      };
      for (let round = 0; round < rounds; round++) {
        const roll = dice.roll();
        if (roll !== 7) {
          const income = p.incomeByNumber.get(roll);
          if (income) {
            for (const [res, count] of Object.entries(income)) {
              hand[res] += count ?? 0;
            }
          }
          if (extraBuildings > 0 && mixTotal > 0) {
            for (const r of RESOURCES) {
              hand[r] += baseProd[r] / mixTotal * perBuilding * extraBuildings;
            }
          }
        } else if (handTotal({ ...p, hand }) > discardLimit) {
          for (const r of RESOURCES) hand[r] = Math.floor(hand[r] * 0.55);
        }
        const order = strategy.buildOrder;
        if (tryBuy(order[orderIdx % order.length])) orderIdx++;
        else {
          for (const alt of ["city", "settlement", "dev", "road"]) {
            if (alt !== order[orderIdx % order.length] && tryBuy(alt)) break;
          }
        }
      }
      vpSum += built.settlements + built.cities + built.devs * 0.3 + (built.devs >= 5 ? 2 : 0);
    }
    return vpSum / trials;
  }
  function rankLiveStrategies(state, name, priors) {
    const p = state.players.get(name);
    if (!p) return [];
    const prod = expectedProduction(p);
    const total2 = productionTotal(prod);
    const fits = STRATEGIES.map((strategy, i) => {
      const rationale = [];
      let score = 0;
      for (const r of RESOURCES) score += prod[r] * strategy.weights[r] * 36;
      const keyRes = RESOURCES.filter((r) => strategy.weights[r] >= 1.4);
      if (keyRes.length > 0 && total2 > 0) {
        const keyShare = keyRes.reduce((s, r) => s + prod[r], 0) / total2;
        if (keyShare >= 0.45) {
          rationale.push(`${Math.round(keyShare * 100)}% of your income is ${keyRes.join("+")}`);
        } else {
          rationale.push(`only ${Math.round(keyShare * 100)}% of your income is ${keyRes.join("/")}`);
        }
      }
      if (strategy.id === "port-trade") {
        const port = RESOURCES.find((r) => (p.bankRatio[r] ?? 4) === 2);
        if (port) {
          score += prod[port] * 36 * 1.5;
          rationale.push(`2:1 ${port} port confirmed from your bank trades`);
        } else {
          score *= 0.6;
          rationale.push("no 2:1 port observed yet");
        }
      }
      if (strategy.id === "city-dev" && p.knightsPlayed >= 2) {
        score += 3;
        rationale.push(`${p.knightsPlayed} knights played — Largest Army is in reach`);
      }
      if (strategy.id === "road-expand" && p.roads >= 6) {
        score += 3;
        rationale.push(`${p.roads} roads down — press for Longest Road`);
      }
      const simVp = simulateLive(p, strategy, 1e3 + i * 31, state.discardLimit);
      score *= (priors == null ? void 0 : priors[strategy.id]) ?? 1;
      return { strategy, score, simVp, rationale };
    });
    const maxScore = Math.max(...fits.map((f) => f.score), 1);
    const maxVp = Math.max(...fits.map((f) => f.simVp), 0.1);
    return fits.sort(
      (a, b) => 0.45 * (b.score / maxScore) + 0.55 * (b.simVp / maxVp) - (0.45 * (a.score / maxScore) + 0.55 * (a.simVp / maxVp))
    );
  }
  function bestFitWeights(p) {
    const prod = expectedProduction(p);
    let best = STRATEGIES[0];
    let bestScore = -Infinity;
    for (const s of STRATEGIES) {
      const score = RESOURCES.reduce((sum2, r) => sum2 + prod[r] * s.weights[r], 0);
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    return best.weights;
  }
  function robberAdvice(state) {
    var _a;
    const you = state.youName;
    const opponents = [...state.players.values()].filter((p2) => p2.name !== you);
    if (opponents.length === 0) return null;
    const scored = opponents.map((p2) => {
      const prod = productionTotal(expectedProduction(p2));
      return { p: p2, threat: visibleVp(p2) * 1.2 + prod * 36 * 0.6 + handTotal(p2) * 0.15 };
    }).sort((a, b) => b.threat - a.threat);
    const { p } = scored[0];
    const needs = bestFitWeights(p);
    const deck = deckStatus(state);
    const dueNess = (n) => {
      const base = pips(n) / 36;
      if (base <= 0) return 1;
      return Math.min(2, Math.max(0.25, (deck.prob.get(n) ?? base) / base));
    };
    const yourIncome = you ? (_a = state.players.get(you)) == null ? void 0 : _a.incomeByNumber : void 0;
    let best = null;
    for (const [n, delta] of p.incomeByNumber) {
      let value = 0;
      for (const [res, count] of Object.entries(delta)) {
        value += (count ?? 0) * pips(n) * needs[res] * dueNess(n);
      }
      if (yourIncome == null ? void 0 : yourIncome.has(n)) value *= 0.5;
      if (!best || value > best.value) best = { n, value };
    }
    let blockHint = "";
    if (best) {
      const payout = describeDelta(p.incomeByNumber.get(best.n));
      const alsoYours = (yourIncome == null ? void 0 : yourIncome.has(best.n)) ? " (careful: a tile on that number may pay you too)" : "";
      const hot = dueNess(best.n) >= 1.35 ? " — it's over-due in the dice shoe right now" : dueNess(best.n) <= 0.75 ? " (though the shoe says it's cold)" : "";
      blockHint = ` Block their ${best.n} — it pays them ${payout}, which their plan needs most${hot}${alsoYours}.`;
    }
    const friendly = visibleVp(p) < 3 ? ` They're under 3 VP, so with friendly robber you can't steal — blocking the tile still works.` : "";
    return {
      target: p.name,
      reason: `${p.name} leads the threat board: ${visibleVp(p)} visible VP, ~${(productionTotal(expectedProduction(p)) * 36).toFixed(0)} pips of income, ${handTotal(p)}${p.uncertainty ? `±${p.uncertainty}` : ""} cards in hand.` + blockHint + friendly
    };
  }
  function describeDelta(d) {
    return Object.entries(d).filter(([, v]) => (v ?? 0) > 0).map(([r, v]) => `${v} ${r}`).join(", ");
  }
  function isOneVsOne(state) {
    return state.players.size === 2;
  }
  function tradeTips(state, name, fit) {
    const p = state.players.get(name);
    if (!p || !fit) return [];
    const tips = [];
    const w = fit.strategy.weights;
    const prod = expectedProduction(p);
    const oneVsOne = isOneVsOne(state);
    for (const item of fit.strategy.buildOrder) {
      const cost = BUILD_COSTS$1[item];
      const missing = RESOURCES.filter((r) => (cost[r] ?? 0) > p.hand[r]);
      const missingCount = missing.reduce((s, r) => s + (cost[r] ?? 0) - p.hand[r], 0);
      if (missingCount === 0) break;
      if (missingCount <= 2) {
        const surplus = RESOURCES.filter(
          (r) => p.hand[r] - (cost[r] ?? 0) >= (p.bankRatio[r] ?? 4)
        );
        if (oneVsOne) {
          if (surplus.length) {
            tips.push({
              text: `${missingCount} card${missingCount > 1 ? "s" : ""} short of a ${item}: bank-trade ${surplus[0]} (${p.bankRatio[surplus[0]] ?? 4}:1) for ${missing.join(" + ")}.`
            });
          }
        } else {
          tips.push({
            text: `One trade from a ${item}: get ${missing.join(" + ")}` + (surplus.length ? `, offer ${surplus.join(" or ")}` : "") + "."
          });
        }
        break;
      }
    }
    const surplusRes = [...RESOURCES].sort(
      (a, b) => prod[b] * (2 - w[b]) - prod[a] * (2 - w[a])
    )[0];
    const neededRes = [...RESOURCES].sort((a, b) => w[b] - w[a]).find((r) => prod[r] < 0.05);
    if (surplusRes && neededRes && surplusRes !== neededRes) {
      tips.push({
        text: oneVsOne ? `Long-term: you produce almost no ${neededRes}. No player trades in 1v1 — funnel surplus ${surplusRes} through the bank or grab a ${neededRes} port.` : `Long-term: your ${surplusRes} income is expendable for ${fit.strategy.name}; you produce almost no ${neededRes} — trade or port toward it.`
      });
    }
    const ratio = RESOURCES.find((r) => (p.bankRatio[r] ?? 4) <= 3);
    if (ratio && !oneVsOne) {
      tips.push({
        text: `Never accept a worse deal than your ${p.bankRatio[ratio]}:1 bank rate on ${ratio}.`
      });
    }
    return tips;
  }
  function planDiscard(hand, count, fit, reserve, weights) {
    const keep = reserve ?? (fit ? { ...BUILD_COSTS$1[fit.strategy.buildOrder[0]] } : {});
    const pool = { ...hand };
    const out = {};
    for (let i = 0; i < count; i++) {
      const avail = RESOURCES.filter((r) => pool[r] > 0);
      if (avail.length === 0) break;
      const pick = avail.sort(
        (a, b) => pool[b] - (keep[b] ?? 0) - (pool[a] - (keep[a] ?? 0)) || (weights ? weights[a] - weights[b] : fit ? fit.strategy.weights[a] - fit.strategy.weights[b] : 0)
      )[0];
      pool[pick]--;
      out[pick] = (out[pick] ?? 0) + 1;
    }
    return out;
  }
  function nextMoves(state, name, fit, facts) {
    const p = state.players.get(name);
    if (!p || !fit) return [];
    const actions = [];
    const hand = { ...p.hand };
    const total2 = RESOURCES.reduce((s, r) => s + hand[r], 0);
    if (total2 > state.discardLimit) {
      const keepFor = fit.strategy.buildOrder[0];
      const plan = planDiscard(hand, Math.floor(total2 / 2), fit);
      actions.push({
        text: `If a 7 rolls, discard ${Object.entries(plan).map(([r, n]) => `${n} ${r}`).join(" + ")} — keep the makings of a ${keepFor}.`,
        primary: false
      });
    }
    const canAfford = (item) => RESOURCES.every((r) => hand[r] >= (BUILD_COSTS$1[item][r] ?? 0));
    const pay = (item) => {
      for (const r of RESOURCES) hand[r] -= BUILD_COSTS$1[item][r] ?? 0;
    };
    const tried = /* @__PURE__ */ new Set();
    for (const item of [...fit.strategy.buildOrder, "city", "settlement", "dev", "road"]) {
      if (tried.has(item)) continue;
      tried.add(item);
      if (!canAfford(item)) continue;
      if (item === "city") {
        if (p.settlements > 0) {
          actions.push({
            text: (facts == null ? void 0 : facts.cityUpgradeLabel) ? `Build a city: upgrade your settlement at ${facts.cityUpgradeLabel}.` : "Build a city on your best-producing settlement.",
            primary: true
          });
          pay(item);
        }
      } else if (item === "settlement") {
        if (!facts || facts.canPlaceSettlement) {
          actions.push({
            text: (facts == null ? void 0 : facts.bestSpotLabel) ? `Build a settlement at ① ${facts.bestSpotLabel}.` : "Build a settlement at the marked spot.",
            primary: true
          });
          pay(item);
        } else {
          actions.push({
            text: `You can afford a settlement but nowhere legal is connected — build the dashed road toward ① first.`,
            primary: !actions.some((a) => a.primary)
          });
        }
      } else if (item === "dev") {
        actions.push({ text: "Buy a development card.", primary: true });
        pay(item);
      } else if (item === "road") {
        if (!facts || facts.hasRoadSuggestion) {
          actions.push({
            text: "Build a road along the dashed segment toward ①.",
            primary: true
          });
          pay(item);
        }
      }
    }
    if (!actions.some((a) => a.primary)) {
      let bestItem = fit.strategy.buildOrder[0];
      let bestMissing = Infinity;
      for (const item of fit.strategy.buildOrder) {
        const missing = RESOURCES.reduce(
          (s, r) => s + Math.max(0, (BUILD_COSTS$1[item][r] ?? 0) - hand[r]),
          0
        );
        if (missing < bestMissing) {
          bestMissing = missing;
          bestItem = item;
        }
      }
      const missingList = RESOURCES.filter((r) => (BUILD_COSTS$1[bestItem][r] ?? 0) > hand[r]).map((r) => `${(BUILD_COSTS$1[bestItem][r] ?? 0) - hand[r]} ${r}`).join(" + ");
      actions.push({
        text: `Nothing to build yet — save for a ${bestItem} (need ${missingList || "nothing"}).`,
        primary: true
      });
    }
    return actions;
  }
  const zeroHand = () => ({ wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 });
  function planningAdvice(advice, planning, state) {
    var _a, _b, _c;
    if (advice.phase === "setup") return advice;
    const settlements = planning.builds.filter((b) => b.kind === "settlement" && b.vertexId !== void 0).slice(0, 3);
    const target = ((_a = planning.builds[0]) == null ? void 0 : _a.kind) === "road" ? planning.builds[0] : settlements[0];
    return {
      ...advice,
      heading: "Expansion within the remaining game",
      spots: settlements.map((b, i) => ({
        vertexId: b.vertexId,
        rank: i + 1,
        label: describeVertex(state, b.vertexId)
      })),
      roadEdges: ((_b = target == null ? void 0 : target.roadEdges) == null ? void 0 : _b.slice(0, 2)) ?? [],
      roadPathLength: ((_c = target == null ? void 0 : target.roadEdges) == null ? void 0 : _c.length) ?? 0,
      note: target ? `~${planning.horizon.turns.toFixed(1)} turns of useful production remain in the race estimate.` : null,
      race: void 0
    };
  }
  function vertexIncome(state, vertexId, rolls = 2) {
    const result = zeroHand();
    for (const id of state.board.vertices[vertexId].hexIds) {
      const h = state.board.hexes[id];
      if (h.kind !== "desert") result[h.kind] += pips(h.token) / 36 * rolls;
    }
    return result;
  }
  function settlementRoutes(state, player) {
    const network = new Set(state.roads.filter((r) => r.player === player).flatMap((r) => [state.board.edges[r.edgeId].a, state.board.edges[r.edgeId].b]));
    return state.board.vertices.filter((v) => isVertexBuildable(state, v.id)).flatMap((v) => {
      const edges = roadPathTo(state, player, v.id);
      return edges.length || network.has(v.id) ? [{ vertexId: v.id, edges, conflicts: v.adjacent, production: vertexIncome(state, v.id, 1) }] : [];
    });
  }
  function longestRoad(state, player) {
    const edges = state.roads.filter((r) => r.player === player).map((r) => state.board.edges[r.edgeId]);
    const blocked = new Set(state.buildings.filter((b) => b.player !== player).map((b) => b.vertexId));
    const walk = (v, used) => {
      if (used.size && blocked.has(v)) return used.size;
      let best = used.size;
      for (const edge of edges) if (!used.has(edge.id) && (edge.a === v || edge.b === v)) {
        used.add(edge.id);
        best = Math.max(best, walk(edge.a === v ? edge.b : edge.a, used));
        used.delete(edge.id);
      }
      return best;
    };
    return Math.max(0, ...[...new Set(edges.flatMap((e) => [e.a, e.b]))].map((v) => walk(v, /* @__PURE__ */ new Set())));
  }
  function roadBonusPath(state, player, target, supply) {
    let frontier = [[]];
    const occupied = new Set(state.roads.map((r) => r.edgeId));
    const blocked = new Set(state.buildings.filter((b) => b.player !== player).map((b) => b.vertexId));
    for (let depth = 0; depth <= Math.min(3, supply); depth++) {
      const next = [];
      const winners = [];
      for (const path of frontier) {
        const trial = { ...state, roads: [...state.roads, ...path.map((edgeId) => ({ edgeId, player }))] };
        const length = longestRoad(trial, player);
        if (length >= target) {
          const access = settlementRoutes(trial, player).filter((r) => r.edges.length <= supply - path.length).reduce((best, r) => Math.max(
            best,
            Object.values(r.production ?? {}).reduce((n, x) => n + x, 0) / (1 + r.edges.length)
          ), 0);
          winners.push({ path, access });
          continue;
        }
        const nodes = new Set(trial.roads.filter((r) => r.player === player).flatMap((r) => [state.board.edges[r.edgeId].a, state.board.edges[r.edgeId].b]));
        for (const b of state.buildings) if (b.player === player) nodes.add(b.vertexId);
        for (const edge of state.board.edges) if (!occupied.has(edge.id) && !path.includes(edge.id) && (nodes.has(edge.a) && !blocked.has(edge.a) || nodes.has(edge.b) && !blocked.has(edge.b))) {
          next.push({ path: [...path, edge.id], length });
        }
      }
      if (winners.length) return winners.sort((a, b) => b.access - a.access)[0].path;
      const seen = /* @__PURE__ */ new Set();
      frontier = next.sort((a, b) => b.length - a.length).filter((x) => {
        const key = [...x.path].sort((a, b) => a - b).join(",");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, 32).map((x) => x.path);
    }
    return null;
  }
  function planPosition(tracker2, youName, gs, opts = {}) {
    var _a, _b;
    const target = opts.target ?? 10;
    const rolls = Math.max(2, tracker2.players.size);
    const you = tracker2.players.get(youName);
    const ids = [...tracker2.players.keys()];
    const inputs = opts.inputs ?? [...tracker2.players.values()].map((p) => {
      const player = p.name === youName ? gs == null ? void 0 : gs.youPlayer : gs && gs.youPlayer !== null && tracker2.players.size === 2 ? gs.youPlayer === 0 ? 1 : 0 : ids.indexOf(p.name);
      const own = !!gs && player !== null && player !== void 0 ? gs.state.buildings.filter((b) => b.player === player) : [];
      const ownRoads = gs && player !== null && player !== void 0 ? gs.state.roads.filter((r) => r.player === player).length : p.roads;
      const routes = gs && player !== null && player !== void 0 ? settlementRoutes(gs.state, player) : void 0;
      return {
        name: p.name,
        playerId: player ?? void 0,
        isYou: p.name === youName,
        publicVp: visibleVp(p),
        hiddenVp: p.name === youName ? opts.hiddenVp ?? 0 : Math.min(5, p.devCards * 0.2),
        settlementsLeft: p.name === youName && opts.pieces ? opts.pieces.settlements : Math.max(0, 5 - p.settlements),
        citiesLeft: p.name === youName && opts.pieces ? opts.pieces.cities : Math.max(0, 4 - p.cities),
        roadsLeft: p.name === youName && opts.pieces ? opts.pieces.roads : Math.max(0, 15 - ownRoads),
        settlementsOnBoard: gs ? own.filter((b) => b.kind === "settlement").length : p.settlements,
        settlementSpotOpen: (routes == null ? void 0 : routes.some((r) => r.edges.length === 0)) ?? false,
        settlementRoutes: routes,
        knightsPlayed: p.knightsPlayed,
        knightsInHand: p.name === youName ? opts.knightsInHand : 0,
        playableKnights: p.name === youName ? opts.playableKnights : 0,
        longestRoadLen: gs && player !== null && player !== void 0 ? longestRoad(gs.state, player) : 0,
        hand: p.hand,
        production: gs && player !== null && player !== void 0 ? playerProduction(gs.state, player) : expectedProduction(p),
        cityProduction: gs ? own.filter((b) => b.kind === "settlement").map((b) => vertexIncome(gs.state, b.vertexId, 1)) : void 0,
        bankRatios: p.bankRatio,
        rollsPerTurn: rolls
      };
    });
    const mostKnights = Math.max(0, ...inputs.map((p) => p.knightsPlayed));
    const mostRoads = Math.max(0, ...inputs.map((p) => p.longestRoadLen));
    for (const p of inputs) {
      p.holdsLargestArmy ?? (p.holdsLargestArmy = mostKnights >= 3 && p.knightsPlayed === mostKnights && inputs.filter((x) => x.knightsPlayed === mostKnights).length === 1);
      p.holdsLongestRoad ?? (p.holdsLongestRoad = mostRoads >= 5 && p.longestRoadLen === mostRoads && inputs.filter((x) => x.longestRoadLen === mostRoads).length === 1);
    }
    const victories = analyzeVictory(inputs, { target, devDeckLeft: opts.devDeckLeft ?? null });
    const horizon = gameHorizon(victories.map((v) => v.turnsToWin));
    const me = inputs.find((p) => p.isYou);
    const victory = victories.find((p) => p.isYou);
    const paidRoads = /* @__PURE__ */ new Set();
    const remaining = (victory == null ? void 0 : victory.steps.reduce((cost, step) => {
      for (const r of RESOURCES) cost[r] = (cost[r] ?? 0) + (step.cost[r] ?? 0);
      for (const id of step.roadEdges ?? []) {
        if (paidRoads.has(id)) {
          cost.wood = (cost.wood ?? 0) - 1;
          cost.brick = (cost.brick ?? 0) - 1;
        }
        paidRoads.add(id);
      }
      return cost;
    }, {})) ?? {};
    const production = Object.fromEntries(RESOURCES.map((r) => [r, me.production[r] * rolls]));
    const gap = Math.max(0, target - me.publicVp - (me.hiddenVp ?? 0));
    const options = [];
    if (gs && gs.youPlayer !== null) {
      if ((me.citiesLeft ?? 0) > 0) {
        for (const b of gs.state.buildings) if (b.player === gs.youPlayer && b.kind === "settlement") {
          options.push({ kind: "city", vp: 1, cost: BUILD.city, production: vertexIncome(gs.state, b.vertexId, rolls), vertexId: b.vertexId });
        }
      }
      if ((me.settlementsLeft ?? 0) > 0) for (const route of me.settlementRoutes ?? settlementRoutes(gs.state, gs.youPlayer)) {
        if (route.edges.length > (me.roadsLeft ?? 0)) continue;
        const ratios = { ...you.bankRatio };
        const port = gs.state.board.vertices[route.vertexId].port;
        if (port) {
          for (const r of RESOURCES) if (port.kind === "any" || port.kind === r) ratios[r] = Math.min(ratios[r] ?? 4, port.ratio);
        }
        options.push({
          kind: "settlement",
          vp: 1,
          cost: { wood: 1 + route.edges.length, brick: 1 + route.edges.length, wheat: 1, sheep: 1 },
          production: vertexIncome(gs.state, route.vertexId, rolls),
          vertexId: route.vertexId,
          roadEdges: route.edges,
          ratios
        });
      }
      if (((_a = me.longestRoadPath) == null ? void 0 : _a.length) && !me.holdsLongestRoad) options.push({
        kind: "road",
        vp: 2,
        cost: { wood: me.longestRoadPath.length, brick: me.longestRoadPath.length },
        production: zeroHand(),
        roadEdges: me.longestRoadPath
      });
    }
    if (!gs && me.settlementsOnBoard > 0 && (me.citiesLeft ?? 0) > 0) {
      options.push({
        kind: "city",
        cost: BUILD.city,
        vp: 1,
        production: Object.fromEntries(RESOURCES.map((r) => [r, production[r] / Math.max(1, me.settlementsOnBoard)]))
      });
    }
    if (opts.devDeckLeft !== 0) {
      const leader = Math.max(2, ...inputs.map((p) => p.knightsPlayed));
      const needed = Math.max(1, leader + 1 - me.knightsPlayed - (me.knightsInHand ?? 0));
      const armyValue = me.holdsLargestArmy ? 0 : 14 / 25 * 2 / needed * horizon.turns / (horizon.turns + needed);
      const unblocking = zeroHand();
      if (opts.robberHex && gs && gs.youPlayer !== null && !opts.knightsInHand) {
        const hex = gs.state.board.hexes.find((h) => h.q === opts.robberHex.x && h.r === opts.robberHex.y);
        if (hex && hex.kind !== "desert") {
          const units = gs.state.buildings.filter((b) => b.player === gs.youPlayer && gs.state.board.vertices[b.vertexId].hexIds.includes(hex.id)).reduce((n, b) => n + (b.kind === "city" ? 2 : 1), 0);
          const duration = Math.max(0, Math.min(horizon.turns, 3) - 1);
          unblocking[hex.kind] = pips(hex.token) / 36 * rolls * units * (14 / 25) * duration / Math.max(1, horizon.turns);
        }
      }
      options.push({ kind: "dev", cost: BUILD.dev, vp: 5 / 25 + armyValue, production: unblocking });
    }
    const builds = evaluateBuilds(options, you.hand, production, you.bankRatio, remaining, gap, horizon);
    const total2 = RESOURCES.reduce((n, r) => n + you.hand[r], 0);
    if (total2 > tracker2.discardLimit) {
      const seven = deckStatus(tracker2).prob.get(7) ?? 1 / 6;
      for (const build of builds) if (build.wait > 0) {
        const discard = planDiscard(you.hand, Math.floor(total2 / 2), null, build.cost);
        const retained = Object.fromEntries(RESOURCES.map((r) => [r, you.hand[r] - (discard[r] ?? 0)]));
        const after = evaluateBuilds([build], retained, production, you.bankRatio, remaining, gap, horizon)[0];
        const exposure = 1 - Math.pow(1 - seven, rolls * Math.max(1, build.wait));
        build.score = (1 - exposure) * build.score + exposure * Math.min(build.score, after.score);
      }
      builds.sort((a, b) => b.score - a.score || a.wait - b.wait);
    }
    const reserve = ((_b = builds[0]) == null ? void 0 : _b.cost) ?? remaining;
    const weights = Object.fromEntries(RESOURCES.map((r) => [
      r,
      1 + Math.max(0, (reserve[r] ?? 0) - you.hand[r]) / (1 + production[r] * horizon.turns)
    ]));
    return { horizon, inputs, victories, options, builds, remaining, weights, production, gap };
  }
  const ALT_TO_RESOURCE = {
    grain: "wheat",
    wool: "sheep",
    lumber: "wood",
    brick: "brick",
    ore: "ore"
  };
  const RESOURCE_IMG_SELECTOR = Object.keys(ALT_TO_RESOURCE).flatMap((a) => [`img[alt="${a}"]`, `img[alt="${cap(a)}"]`]).join(", ");
  function cap(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function resourceFromAlt(alt) {
    if (!alt) return null;
    return ALT_TO_RESOURCE[alt.toLowerCase()] ?? null;
  }
  function getPlayerName(el) {
    var _a;
    const span = el.querySelector(
      'span[style*="font-weight:600"], span[style*="font-weight: 600"]'
    );
    return ((_a = span == null ? void 0 : span.textContent) == null ? void 0 : _a.trim()) || null;
  }
  function getPlayerColor(el) {
    const span = el.querySelector(
      'span[style*="font-weight:600"], span[style*="font-weight: 600"]'
    );
    return (span == null ? void 0 : span.style.color) || "#888";
  }
  function getSecondPlayerName(el) {
    var _a;
    const spans = el.querySelectorAll(
      'span[style*="font-weight:600"], span[style*="font-weight: 600"]'
    );
    return spans.length > 1 ? ((_a = spans[1].textContent) == null ? void 0 : _a.trim()) || null : null;
  }
  function countResources(root) {
    const out = {};
    root.querySelectorAll(RESOURCE_IMG_SELECTOR).forEach((img) => {
      const res = resourceFromAlt(img.getAttribute("alt"));
      if (res) out[res] = (out[res] ?? 0) + 1;
    });
    return out;
  }
  function countAroundMarker(el, marker) {
    const html = el.innerHTML;
    const idx = html.indexOf(marker);
    if (idx === -1) return null;
    const mk = (fragment) => {
      const div = el.ownerDocument.createElement("div");
      div.innerHTML = fragment;
      return countResources(div);
    };
    return { before: mk(html.slice(0, idx)), after: mk(html.slice(idx + marker.length)) };
  }
  function sum(d) {
    return Object.values(d).reduce((s, n) => s + (n ?? 0), 0);
  }
  function negate(d) {
    const out = {};
    for (const [k, v] of Object.entries(d)) out[k] = -(v ?? 0);
    return out;
  }
  function merge(a, b) {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) {
      out[k] = (out[k] ?? 0) + (v ?? 0);
    }
    return out;
  }
  function hasImg(el, names) {
    return names.some(
      (n) => el.querySelector(`img[alt="${n}"], img[alt="${cap(n)}"]`)
    );
  }
  function parseLogRow(el) {
    var _a;
    const text = ((_a = el.textContent) == null ? void 0 : _a.replace(/\s+/g, " ").trim()) || "";
    const player = getPlayerName(el);
    if (!text || text.includes("has disconnected") || text.includes("has reconnected") || text.includes("will take over") || text.includes("left the game") || text.includes("Learn how to play") || el.querySelector("hr")) {
      return { type: "ignored" };
    }
    if (text.includes("won the game")) {
      return { type: "game-over", winner: player };
    }
    if (text.includes("rolled")) {
      const dice = el.querySelectorAll('img[alt^="dice_"]');
      if (dice.length === 2 && player) {
        const total2 = parseInt(dice[0].getAttribute("alt").replace("dice_", ""), 10) + parseInt(dice[1].getAttribute("alt").replace("dice_", ""), 10);
        return { type: "roll", player, total: total2 };
      }
      return { type: "ignored" };
    }
    if (text.includes("blocked by the Robber")) {
      const probImg = el.querySelector('img[alt^="prob_"]');
      const tileImg = el.querySelector('img[alt$=" tile"]');
      const total2 = probImg ? parseInt(probImg.getAttribute("alt").replace("prob_", ""), 10) : NaN;
      const res = tileImg ? resourceFromAlt(tileImg.getAttribute("alt").replace(" tile", "")) : null;
      if (!Number.isNaN(total2) && res) return { type: "blocked-roll", total: total2, resource: res };
      return { type: "ignored" };
    }
    if (text.includes("received starting resources") && player) {
      return { type: "starting-resources", player, resources: countResources(el) };
    }
    if (text.includes("placed a") && player) {
      if (hasImg(el, ["settlement"])) {
        return { type: "place", player, color: getPlayerColor(el), what: "settlement" };
      }
      if (hasImg(el, ["road"])) {
        return { type: "place", player, color: getPlayerColor(el), what: "road" };
      }
      if (hasImg(el, ["city"])) {
        return { type: "place", player, color: getPlayerColor(el), what: "city" };
      }
    }
    if (text.includes("built a") && player) {
      if (hasImg(el, ["settlement"])) return { type: "build", player, what: "settlement" };
      if (hasImg(el, ["city"])) return { type: "build", player, what: "city" };
      if (hasImg(el, ["road"])) return { type: "build", player, what: "road" };
    }
    if (text.includes("bought") && el.querySelector(
      'img[alt="development card"], img[alt="Development card"], img[alt="Development Card"]'
    ) && player) {
      return { type: "buy-dev", player };
    }
    if (text.includes("gave bank") && text.includes("took") && player) {
      const parts = countAroundMarker(el, " and took ");
      if (parts) {
        return {
          type: "bank-trade",
          player,
          delta: merge(negate(parts.before), parts.after),
          gave: sum(parts.before),
          took: sum(parts.after)
        };
      }
    }
    if (text.includes("gave") && text.includes("got") && text.includes("from")) {
      const html = el.innerHTML;
      const gotIdx = html.indexOf(" and got ");
      const fromIdx = html.lastIndexOf(" from ");
      if (gotIdx !== -1 && fromIdx > gotIdx && player) {
        const mk = (fragment) => {
          const div = el.ownerDocument.createElement("div");
          div.innerHTML = fragment;
          return countResources(div);
        };
        const gave = mk(html.slice(0, gotIdx));
        const got = mk(html.slice(gotIdx + " and got ".length, fromIdx));
        return {
          type: "player-trade",
          player,
          partner: getSecondPlayerName(el),
          delta: merge(negate(gave), got)
        };
      }
    }
    if (/stole \d+/.test(text) && player) {
      const res = countResources(el);
      const kind = Object.keys(res)[0];
      const m = text.match(/stole (\d+)/);
      if (kind && m) {
        return { type: "monopoly-steal", player, resource: kind, count: parseInt(m[1], 10) };
      }
    }
    if (text.includes("stole") && text.includes("from")) {
      const res = countResources(el);
      const kind = Object.keys(res)[0] ?? null;
      const isYouThief = /^You stole/i.test(text);
      const isYouVictim = / from you/i.test(text);
      const first = player;
      const second = getSecondPlayerName(el);
      const thief = isYouThief ? null : first;
      const victim = isYouVictim ? null : isYouThief ? first : second;
      if (kind) return { type: "steal-known", thief, victim, resource: kind };
      return { type: "steal-unknown", thief, victim };
    }
    if (text.includes("took from bank") && player) {
      return { type: "take-from-bank", player, resources: countResources(el) };
    }
    if (text.includes("discarded") && player) {
      return { type: "discard", player, resources: countResources(el) };
    }
    if (text.includes("used") && player) {
      if (text.includes("Knight")) return { type: "use-knight", player };
      if (text.includes("Year of Plenty")) return { type: "use-dev", player, card: "year-of-plenty" };
      if (text.includes("Road Building")) return { type: "use-dev", player, card: "road-building" };
      if (text.includes("Monopoly")) return { type: "use-dev", player, card: "monopoly" };
    }
    if (text.includes("moved Robber") && player) {
      return { type: "move-robber", player };
    }
    if (text.includes("got") && player) {
      const resources = countResources(el);
      if (sum(resources) > 0) return { type: "got", player, resources };
    }
    return { type: "ignored" };
  }
  const SQRT3 = Math.sqrt(3);
  function faceFromCenter(cx, cy) {
    const y = cy / 1.5;
    const x = (cx - SQRT3 / 2 * y) / SQRT3;
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (Math.abs(x - xi) > 0.02 || Math.abs(y - yi) > 0.02) return null;
    return { x: xi, y: yi };
  }
  function pixelToColonistCorner(px, py) {
    const top = faceFromCenter(px, py + 1);
    if (top) return { x: top.x, y: top.y, z: 0 };
    const bottom = faceFromCenter(px, py - 1);
    if (bottom) return { x: bottom.x, y: bottom.y, z: 1 };
    return null;
  }
  const EDGE_CORNER_ANGLES = [0, 1, 2].map((z) => [
    60 * (5 - z) - 30,
    60 * (4 - z) - 30
  ]);
  function pixelsToColonistEdge(p1, p2) {
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    for (let z = 0; z < 3; z++) {
      const [a1, a2] = EDGE_CORNER_ANGLES[z];
      const ox = (Math.cos(Math.PI / 180 * a1) + Math.cos(Math.PI / 180 * a2)) / 2;
      const oy = (Math.sin(Math.PI / 180 * a1) + Math.sin(Math.PI / 180 * a2)) / 2;
      const face = faceFromCenter(mx - ox, my - oy);
      if (face) {
        const c1 = {
          x: SQRT3 * face.x + SQRT3 / 2 * face.y + Math.cos(Math.PI / 180 * a1),
          y: 1.5 * face.y + Math.sin(Math.PI / 180 * a1)
        };
        const c2 = {
          x: SQRT3 * face.x + SQRT3 / 2 * face.y + Math.cos(Math.PI / 180 * a2),
          y: 1.5 * face.y + Math.sin(Math.PI / 180 * a2)
        };
        const close = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < 0.05;
        if (close(c1, p1) && close(c2, p2) || close(c1, p2) && close(c2, p1)) {
          return { x: face.x, y: face.y, z };
        }
      }
    }
    return null;
  }
  const MOVE_ROBBER_BANNER = /^(you (must|have to) )?((move|place|drop)( the)? robber|select .{0,20}robber)/i;
  const YOUR_TURN_BANNER = /\b(your turn|roll dice|build or trade|trade or build)\b/i;
  const DISCARD_BANNER = /^(select|choose).{0,25}discard|^discard (\d|cards|resources)/i;
  const PATTERNS = {
    // (?<![a-z]) keeps "roll" from matching inside scroll/scrollbar class names.
    roll: new RegExp("dice|(?<![a-z])roll", "i"),
    "end-turn": /end[_\s-]?turn|pass[_\s-]?turn|hourglass|fast[_\s-]?forward|skip/i,
    "buy-dev": /development|dev[_\s-]?card|card[_\s-]?back|buy[_\s-]?card/i
  };
  function rollPromptVisible(doc = document) {
    const controls = doc.querySelectorAll('button, [role="button"]');
    for (const el of controls) {
      if (el.closest("[data-index]") || el.closest("#catan-copilot")) continue;
      if (!PATTERNS.roll.test(labelOf(el))) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return true;
    }
    return false;
  }
  function labelOf(el) {
    const img = el instanceof HTMLImageElement ? el : el.querySelector("img");
    return [
      el.getAttribute("aria-label"),
      el.getAttribute("title"),
      img == null ? void 0 : img.getAttribute("alt"),
      img == null ? void 0 : img.getAttribute("src"),
      el.id,
      el.className && typeof el.className === "string" ? el.className : ""
    ].filter(Boolean).join(" ");
  }
  function realClick(el) {
    const opts = { bubbles: true, cancelable: true };
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.click();
  }
  function tryDomAction(kind, doc = document, exclude) {
    const pattern = PATTERNS[kind];
    const attempt = (el, allowText) => {
      if (el.closest("[data-index]")) return null;
      if (el.closest("#catan-copilot")) return null;
      if (el.matches('button:disabled, [aria-disabled="true"]')) return null;
      const text = (el.textContent ?? "").trim();
      const label = [labelOf(el), text.length <= 30 ? text : ""].filter(Boolean).join(" ");
      if (!pattern.test(label)) return null;
      const id = label.slice(0, 60);
      if (exclude == null ? void 0 : exclude.has(id)) return null;
      const clickable = el.closest('button, [role="button"]') ?? el.parentElement ?? el;
      const rect = clickable.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      realClick(clickable);
      return id;
    };
    for (const el of [
      ...doc.querySelectorAll('button, [role="button"]'),
      ...doc.querySelectorAll("img")
    ]) {
      const id = attempt(el);
      if (id) return id;
    }
    for (const el of doc.querySelectorAll("div, span, a")) {
      if (el.children.length > 2) continue;
      const text = (el.textContent ?? "").trim();
      if (text.length === 0 || text.length > 20) continue;
      const id = attempt(el);
      if (id) return id;
    }
    return null;
  }
  const RESOURCE_LABELS = {
    wood: /lumber|wood/i,
    brick: /brick/i,
    sheep: /wool|sheep/i,
    wheat: /grain|wheat/i,
    ore: /ore/i
  };
  function findDiscardDialog(doc) {
    let best = null;
    for (const el of doc.querySelectorAll("div, section, dialog")) {
      if (el.closest("[data-index]") || el.closest("#catan-copilot")) continue;
      const text = el.textContent ?? "";
      if (text.length > 300 || !/discard/i.test(text)) continue;
      if (!el.querySelector("img")) continue;
      if (!best || best.contains(el)) best = el;
    }
    return best;
  }
  function tryDomDiscard(cards, doc = document) {
    const dialog = findDiscardDialog(doc);
    if (!dialog) return null;
    const used = /* @__PURE__ */ new Set();
    let clicked = 0;
    for (const [res, n] of Object.entries(cards)) {
      const pattern = RESOURCE_LABELS[res];
      if (!pattern || !n) continue;
      const imgs = [...dialog.querySelectorAll("img")].filter(
        (el) => !used.has(el) && pattern.test(labelOf(el))
      );
      for (let i = 0; i < n && i < imgs.length; i++) {
        used.add(imgs[i]);
        realClick(imgs[i].closest('button, [role="button"]') ?? imgs[i]);
        clicked++;
      }
    }
    if (clicked === 0) return null;
    const confirm = [...dialog.querySelectorAll('button, [role="button"], img')].find(
      (el) => {
        if (used.has(el)) return false;
        const label = `${labelOf(el)} ${(el.textContent ?? "").trim().slice(0, 30)}`;
        return /confirm|check|submit|\bok\b|✓|discard/i.test(label);
      }
    );
    if (confirm) realClick(confirm.closest('button, [role="button"]') ?? confirm);
    return `selected ${clicked} card${clicked === 1 ? "" : "s"}${confirm ? " + confirm" : ""}`;
  }
  function shortfall(hand, cost) {
    return RESOURCES.reduce((s, r) => s + Math.max(0, (cost[r] ?? 0) - hand[r]), 0);
  }
  function decideTradeResponse(hand, offer, plan, handLimit = 7) {
    const give = RESOURCES.reduce((s, r) => s + (offer.wanted[r] ?? 0), 0);
    const get = RESOURCES.reduce((s, r) => s + (offer.offered[r] ?? 0), 0);
    if (get === 0 || give === 0) return { accept: false, reason: "one-sided offer" };
    for (const r of RESOURCES) if ((offer.wanted[r] ?? 0) > hand[r]) return { accept: false, reason: `we don't have ${r}` };
    const after = { ...hand };
    for (const r of RESOURCES) after[r] = hand[r] - (offer.wanted[r] ?? 0) + (offer.offered[r] ?? 0);
    const targets = plan.filter((cost) => shortfall(hand, cost) > 0).slice(0, 2);
    if (targets.length === 0) return { accept: false, reason: "nothing we're saving for" };
    const [first, second] = targets;
    const handSize = RESOURCES.reduce((s, r) => s + hand[r], 0);
    const completesFirst = shortfall(after, first) === 0;
    if (give > get && !(give - get === 1 && completesFirst && handSize >= handLimit)) {
      return { accept: false, reason: `worse than 1:1 (${give} for ${get})` };
    }
    for (const r of RESOURCES) {
      const g = offer.wanted[r] ?? 0;
      if (g === 0) continue;
      if ((first[r] ?? 0) > 0 && after[r] < (first[r] ?? 0)) return { accept: false, reason: `the next build needs the ${r} they want` };
      if (second && (second[r] ?? 0) > 0 && after[r] < (second[r] ?? 0) && hand[r] - g < (first[r] ?? 0) + (second[r] ?? 0)) {
        return { accept: false, reason: `we'd be short of ${r} for the build after` };
      }
    }
    for (const r of RESOURCES) {
      const got = offer.offered[r] ?? 0;
      if (got > 0 && hand[r] >= (first[r] ?? 0) + ((second == null ? void 0 : second[r]) ?? 0) && hand[r] >= 2) {
        return { accept: false, reason: `we already hold enough ${r}` };
      }
    }
    const score = 2 * (shortfall(hand, first) - shortfall(after, first)) + (second ? shortfall(hand, second) - shortfall(after, second) : 0);
    if (score <= 0) return { accept: false, reason: "doesn't bring the plan closer" };
    return { accept: true, reason: completesFirst ? "completes the next build" : `${score > 2 ? "much " : ""}closer to the next builds` };
  }
  function proposeTrade(hand, plan, weights, opts = {}) {
    const target = plan.find((cost) => shortfall(hand, cost) > 0);
    if (!target) return null;
    const short = shortfall(hand, target);
    if (short > 2) return null;
    const needs = RESOURCES.filter((r) => (target[r] ?? 0) > hand[r] && !(opts.alreadyAsked ?? []).includes(r));
    const need = needs[0];
    if (!need) return null;
    const surplus = RESOURCES.filter((r) => r !== need && hand[r] - (target[r] ?? 0) >= 2).sort((a, b) => weights[a] - weights[b]);
    if (surplus.length === 0) return null;
    const handSize = RESOURCES.reduce((s, r) => s + hand[r], 0);
    const sweeten = handSize >= (opts.handLimit ?? 7) - 1 && hand[surplus[0]] - (target[surplus[0]] ?? 0) >= 3;
    return {
      offered: { [surplus[0]]: sweeten ? 2 : 1 },
      wanted: { [need]: 1 },
      reason: `${sweeten ? 2 : 1} ${surplus[0]} for the ${need} our next build is short of`
    };
  }
  function planCosts(fit, _vp, _target = 10) {
    const order = fit ? fit.strategy.buildOrder.filter((i) => i !== "road") : ["city", "settlement"];
    return order.map((i) => BUILD_COSTS[i]);
  }
  const BUILD_COSTS = {
    road: { wood: 1, brick: 1 },
    settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
    city: { ore: 3, wheat: 2 },
    dev: { ore: 1, sheep: 1, wheat: 1 }
  };
  const FIRST_SETTLEMENT_THINK_MS = 3e4;
  function estimateWinProbability(you, opponent, state, board, robberHex, allBuildings) {
    const reasoning = [];
    const yourVp = visibleVp(you);
    const oppVp = visibleVp(opponent);
    const vpDelta = yourVp - oppVp;
    const yourProd = productionTotal(expectedProduction(you));
    const oppProd = productionTotal(expectedProduction(opponent));
    const productionDelta = yourProd - oppProd;
    const devInference = inferOpponentDevCards(opponent, robberHex, state, board, allBuildings);
    let devCardThreat = 0;
    if (devInference.likelyMonopoly) devCardThreat += 0.15;
    if (devInference.likelyVpCard && oppVp >= 8) devCardThreat += 0.25;
    if (devInference.likelyKnight) devCardThreat += 0.1;
    if (devInference.likelyRoadBuilding && oppVp >= 7) devCardThreat += 0.1;
    if (devInference.likelyYearOfPlenty) devCardThreat += 0.1;
    const yourHandTotal = handTotal(you);
    const maxHandResource = Math.max(...RESOURCES.map((r) => you.hand[r]));
    let resourceRisk = 0;
    if (yourHandTotal > state.discardLimit) resourceRisk += 0.1;
    if (maxHandResource >= 5) resourceRisk += 0.1;
    if (devInference.likelyMonopoly && maxHandResource >= 4) resourceRisk += 0.15;
    const youHoldLA = you.knightsPlayed >= 3 && you.knightsPlayed > opponent.knightsPlayed;
    const oppHoldLA = opponent.knightsPlayed >= 3 && opponent.knightsPlayed > you.knightsPlayed;
    const youHoldLR = you.roads >= 5 && you.roads > opponent.roads;
    const oppHoldLR = opponent.roads >= 5 && opponent.roads > you.roads;
    let probability = 0.5 + vpDelta * 0.1;
    probability += productionDelta * 0.05;
    probability -= devCardThreat;
    probability -= resourceRisk;
    if (youHoldLA) {
      probability += 0.1;
      reasoning.push("You hold Largest Army (+2 VP)");
    }
    if (oppHoldLA) {
      probability -= 0.1;
      reasoning.push("Opponent holds Largest Army (-2 VP)");
    }
    if (youHoldLR) {
      probability += 0.1;
      reasoning.push("You hold Longest Road (+2 VP)");
    }
    if (oppHoldLR) {
      probability -= 0.1;
      reasoning.push("Opponent holds Longest Road (-2 VP)");
    }
    probability = Math.max(0.05, Math.min(0.95, probability));
    if (vpDelta > 0) reasoning.push(`Leading by ${vpDelta} VP`);
    else if (vpDelta < 0) reasoning.push(`Trailing by ${-vpDelta} VP`);
    if (productionDelta > 0.1) reasoning.push(`Production advantage (${yourProd.toFixed(2)} vs ${oppProd.toFixed(2)} cards/roll)`);
    else if (productionDelta < -0.1) reasoning.push(`Production deficit (${yourProd.toFixed(2)} vs ${oppProd.toFixed(2)} cards/roll)`);
    if (devCardThreat > 0) reasoning.push(`Opponent dev card threat: ${devInference.reasoning.join(", ")}`);
    if (resourceRisk > 0) reasoning.push(`Your hand vulnerable to monopoly/7 (${yourHandTotal} cards, max ${maxHandResource})`);
    return {
      probability,
      factors: {
        vpDelta,
        productionDelta,
        devCardThreat,
        resourceRisk,
        hasLargestArmy: youHoldLA,
        hasLongestRoad: youHoldLR
      },
      reasoning
    };
  }
  function affordableWithTrades(hand, ratios, cost) {
    let missing = 0;
    for (const r of RESOURCES) missing += Math.max(0, (cost[r] ?? 0) - hand[r]);
    if (missing === 0) return true;
    let power = 0;
    for (const r of RESOURCES) {
      const spare = hand[r] - (cost[r] ?? 0);
      if (spare > 0) power += Math.floor(spare / (ratios[r] ?? 4));
    }
    return power >= missing;
  }
  function tradeTowardCost(hand, ratios, cost, weights) {
    let need = null;
    let needGap = 0;
    for (const r of RESOURCES) {
      const gap = (cost[r] ?? 0) - hand[r];
      if (gap > needGap) {
        needGap = gap;
        need = r;
      }
    }
    if (!need) return null;
    let best = null;
    for (const g of RESOURCES) {
      if (g === need) continue;
      const ratio = ratios[g] ?? 4;
      const surplus = hand[g] - (cost[g] ?? 0);
      if (surplus < ratio) continue;
      const score = -ratio * 100 - weights[g] * 5 + surplus;
      if (!best || score > best.score) best = { give: g, ratio, score };
    }
    return best ? { give: best.give, get: need, giveCount: best.ratio } : null;
  }
  function cardsToIds(cards) {
    const ids = [];
    for (const [r, n] of Object.entries(cards)) {
      for (let i = 0; i < (n ?? 0); i++) ids.push(RESOURCE_TO_CARD_ID[r]);
    }
    return ids;
  }
  function describeCards(cards) {
    return Object.entries(cards).map(([r, n]) => `${n} ${r}`).join(" + ");
  }
  function bestRobberHex(state, youPlayer, current, canRob = () => true, probOf, starve, planning) {
    var _a, _b, _c;
    const oppOnTile = (hexId) => state.buildings.filter(
      (b) => b.player !== youPlayer && state.board.vertices[b.vertexId].hexIds.includes(hexId)
    );
    const tileLegal = (hexId) => oppOnTile(hexId).every((b) => canRob(b.player));
    const combosOf = (token) => {
      if (!probOf) return pips(token);
      return Math.max(0.25, probOf(token) * 36);
    };
    let best = null;
    for (const hex of state.board.hexes) {
      if (hex.kind === "desert" || hex.token === null) continue;
      if (current && hex.q === current.x && hex.r === current.y) continue;
      if (!tileLegal(hex.id)) continue;
      let opp = 0;
      let mine = 0;
      for (const b of state.buildings) {
        if (!state.board.vertices[b.vertexId].hexIds.includes(hex.id)) continue;
        const value = combosOf(hex.token) * (b.kind === "city" ? 2 : 1) * (!planning && starve && hex.kind === starve ? 1.4 : 1);
        if (b.player === youPlayer) mine += value;
        else opp += value;
      }
      let bottleneck = 0;
      if (planning) for (const input of planning.inputs.filter((p) => !p.isYou)) {
        const pid = input.playerId;
        if (pid === void 0) continue;
        const units = state.buildings.filter((b) => b.player === pid && state.board.vertices[b.vertexId].hexIds.includes(hex.id)).reduce((s, b) => s + (b.kind === "city" ? 2 : 1), 0);
        if (!units) continue;
        const goal = ((_b = (_a = planning.victories.find((p) => p.name === input.name)) == null ? void 0 : _a.steps[0]) == null ? void 0 : _b.cost) ?? BUILD_COSTS.city;
        const rate = Object.fromEntries(RESOURCES.map((r) => [r, input.production[r] * (input.rollsPerTurn ?? 2)]));
        const blocked = { ...rate, [hex.kind]: Math.max(0, rate[hex.kind] - pips(hex.token) / 36 * units * (input.rollsPerTurn ?? 2)) };
        const before = turnsToAfford(goal, input.hand, rate, input.bankRatios);
        const after = turnsToAfford(goal, input.hand, blocked, input.bankRatios);
        const horizon = planning.horizon.turns + 1;
        const delay = Number.isFinite(before) ? Math.max(0, after - before) : 0;
        bottleneck += Number.isFinite(delay) ? 6 * delay / (horizon + delay) : 6;
      }
      const score = opp - mine * 1.5 + bottleneck;
      if (opp > 0 && (!best || score > best.score)) best = { score, hexId: hex.id };
    }
    if (best) {
      const hex = state.board.hexes[best.hexId];
      const victim = ((_c = oppOnTile(best.hexId)[0]) == null ? void 0 : _c.player) ?? null;
      return {
        hex: { x: hex.q, y: hex.r },
        victim,
        describe: `robber to the ${hex.token}-${hex.kind} tile${""}`
      };
    }
    const oppPlayers = new Set(
      state.buildings.filter((b) => b.player !== youPlayer).map((b) => b.player)
    );
    const expansionBlock = (() => {
      if (oppPlayers.size === 0) return null;
      let best2 = null;
      for (const h of state.board.hexes) {
        if (h.kind === "desert" || h.token === null) continue;
        if (current && h.q === current.x && h.r === current.y) continue;
        if (!tileLegal(h.id)) continue;
        let blockScore = 0;
        for (const v of state.board.vertices) {
          if (!v.hexIds.includes(h.id)) continue;
          if (!isVertexBuildable(state, v.id)) continue;
          let dist = Infinity;
          for (const op of oppPlayers) {
            dist = Math.min(dist, distanceFromPlayer(state, op, v.id));
          }
          if (dist > 2) continue;
          blockScore += vertexPips(state.board, v.id) * (3 - dist);
        }
        if (blockScore > 0 && (!best2 || blockScore > best2.score)) best2 = { hexId: h.id, score: blockScore };
      }
      return best2;
    })();
    if (expansionBlock) {
      const hex = state.board.hexes[expansionBlock.hexId];
      return {
        hex: { x: hex.q, y: hex.r },
        victim: null,
        describe: `robber to the ${hex.token}-${hex.kind} tile — blocks the spot they're expanding into (friendly robber — no one has 3+ points to rob)`
      };
    }
    const neutral = state.board.hexes.find(
      (h) => h.kind !== "desert" && !(current && h.q === current.x && h.r === current.y) && state.buildings.every((b) => !state.board.vertices[b.vertexId].hexIds.includes(h.id))
    ) ?? state.board.hexes.find((h) => h.kind !== "desert" && tileLegal(h.id));
    if (!neutral) return null;
    return {
      hex: { x: neutral.q, y: neutral.r },
      victim: null,
      describe: `robber to a neutral tile (friendly robber — no one has 3+ points to rob)`
    };
  }
  const COSTS = {
    road: { wood: 1, brick: 1 },
    settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
    city: { ore: 3, wheat: 2 },
    dev: { ore: 1, sheep: 1, wheat: 1 }
  };
  function bestPlaceableNow(state, player) {
    const network = /* @__PURE__ */ new Set();
    for (const b of state.buildings) if (b.player === player) network.add(b.vertexId);
    for (const r of state.roads) {
      if (r.player === player) {
        const e = state.board.edges[r.edgeId];
        network.add(e.a);
        network.add(e.b);
      }
    }
    let best = null;
    let bestPips = -1;
    for (const v of network) {
      if (!isVertexBuildable(state, v)) continue;
      const p = vertexPips(state.board, v);
      if (p > bestPips) {
        bestPips = p;
        best = v;
      }
    }
    return best;
  }
  function bestFreeRoadEdge(state, player) {
    const network = /* @__PURE__ */ new Set();
    for (const b of state.buildings) if (b.player === player) network.add(b.vertexId);
    for (const r of state.roads) {
      if (r.player === player) {
        const e = state.board.edges[r.edgeId];
        network.add(e.a);
        network.add(e.b);
      }
    }
    const taken = new Set(state.roads.map((r) => r.edgeId));
    const oppBuildings = new Set(
      state.buildings.filter((b) => b.player !== player).map((b) => b.vertexId)
    );
    let best = null;
    let bestScore = -1;
    for (const e of state.board.edges) {
      if (taken.has(e.id)) continue;
      const aIn = network.has(e.a);
      const bIn = network.has(e.b);
      if (!aIn && !bIn) continue;
      const from = aIn ? e.a : e.b;
      if (oppBuildings.has(from)) continue;
      const far = aIn ? e.b : e.a;
      const score = vertexPips(state.board, far) + (isVertexBuildable(state, far) ? 6 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = e.id;
      }
    }
    return best;
  }
  function decideNext(opts) {
    var _a, _b, _c, _d, _e;
    const { tracker: tracker2, youName, fit, gs, advice, rolledThisTurn, robberPending, robberHex, discardPending } = opts;
    const you = tracker2.players.get(youName);
    if (!you) return null;
    const allowed = (kind) => !opts.allow || opts.allow.has(kind);
    const board = (gs == null ? void 0 : gs.state.board) ?? null;
    const limit = opts.discardLimit ?? tracker2.discardLimit;
    const handSize = handTotal(you);
    const planning = opts.planning ?? planPosition(tracker2, youName, gs, {
      target: opts.winTarget,
      robberHex: opts.robberHex,
      hiddenVp: opts.vpCardsHeld,
      pieces: opts.piecesLeft,
      devDeckLeft: opts.bankDevCards,
      knightsInHand: opts.knightAvailable ? 1 : 0,
      playableKnights: opts.knightAvailable ? 1 : 0
    });
    const deck = deckStatus(tracker2);
    const probOf = (n) => deck.prob.get(n) ?? pips(n) / 36;
    if (discardPending && handSize > limit) {
      const cards = planDiscard(you.hand, Math.floor(handSize / 2), fit, (_a = planning.builds[0]) == null ? void 0 : _a.cost, planning.weights);
      return {
        kind: "discard",
        cards,
        describe: `discard ${describeCards(cards)} (keeping the next build)`
      };
    }
    if (robberPending && gs && gs.youPlayer !== null && board) {
      const target = bestRobberHex(gs.state, gs.youPlayer, robberHex ?? null, opts.canRob, probOf, void 0, planning);
      if (target) {
        return {
          kind: "move-robber",
          coord: { x: target.hex.x, y: target.hex.y },
          describe: target.describe
        };
      }
      return null;
    }
    const freeRoadChoices = (count) => evaluateBuilds(planning.options.filter((b) => {
      var _a2;
      return (_a2 = b.roadEdges) == null ? void 0 : _a2.length;
    }).map((b) => {
      const free = Math.min(count, b.roadEdges.length);
      return { ...b, cost: { ...b.cost, wood: (b.cost.wood ?? 0) - free, brick: (b.cost.brick ?? 0) - free } };
    }), you.hand, planning.production, you.bankRatio, planning.remaining, planning.gap, planning.horizon);
    if ((opts.freeRoadsPending ?? 0) > 0 && board && gs && gs.youPlayer !== null) {
      const advised = (((_b = freeRoadChoices(opts.freeRoadsPending)[0]) == null ? void 0 : _b.roadEdges) ?? (advice == null ? void 0 : advice.roadEdges) ?? []).find(
        (id) => !gs.state.roads.some((r) => r.edgeId === id)
      );
      const edgeId = advised ?? bestFreeRoadEdge(gs.state, gs.youPlayer);
      if (edgeId !== null && edgeId !== void 0) {
        const e = board.edges[edgeId];
        const coord = pixelsToColonistEdge(board.vertices[e.a], board.vertices[e.b]);
        if (coord) {
          return { kind: "build-road", coord, free: true, describe: "place a free road (Road Building)" };
        }
      }
      return null;
    }
    if ((advice == null ? void 0 : advice.phase) === "setup" && board && gs && gs.youPlayer !== null) {
      if (advice.roadEdges.length > 0) {
        const e = board.edges[advice.roadEdges[0]];
        const coord = pixelsToColonistEdge(board.vertices[e.a], board.vertices[e.b]);
        if (coord) return { kind: "build-road", coord, describe: "setup road (dashed edge)" };
        return null;
      }
      if (advice.spots.length > 0) {
        const v = board.vertices[advice.spots[0].vertexId];
        const coord = pixelToColonistCorner(v.x, v.y);
        if (coord) return { kind: "build-settlement", coord, describe: `settlement at ① ${advice.spots[0].label}` };
      }
      return null;
    }
    const knightReason = (() => {
      var _a2;
      if (!opts.knightAvailable || !allowed("play-knight")) return null;
      const blockedMine = !!robberHex && !!gs && gs.youPlayer !== null && !!board && gs.state.buildings.some(
        (b) => b.player === gs.youPlayer && board.vertices[b.vertexId].hexIds.some(
          (h) => board.hexes[h].q === robberHex.x && board.hexes[h].r === robberHex.y
        )
      );
      if (blockedMine) return "the robber is on your tile";
      const me = planning.inputs.find((p) => p.isYou);
      const armyStep = (_a2 = planning.victories.find((p) => p.isYou)) == null ? void 0 : _a2.steps.find((s) => s.kind === "largest-army");
      if (!(me == null ? void 0 : me.holdsLargestArmy) && armyStep) return "advance the planned Largest Army route before its play deadline";
      return null;
    })();
    const overLimit = handSize > limit;
    if (knightReason && !rolledThisTurn && !overLimit) {
      return { kind: "play-knight", describe: `play a knight before rolling — ${knightReason}` };
    }
    if (!rolledThisTurn) return { kind: "roll", describe: "roll the dice" };
    if (!fit) return null;
    const devAvailable = opts.bankDevCards !== 0 && allowed("buy-dev");
    const pieces = opts.piecesLeft;
    const hasPiece = (item) => {
      if (!pieces) return true;
      const left = item === "settlement" ? pieces.settlements : item === "city" ? pieces.cities : pieces.roads;
      return left === null || left > 0;
    };
    const canBuild = (item) => item === "dev" ? devAvailable : hasPiece(item) && allowed(item === "city" ? "build-city" : item === "road" ? "build-road" : "build-settlement");
    const afford = (item) => RESOURCES.every((r) => you.hand[r] >= (COSTS[item][r] ?? 0));
    const choices = planning.builds.filter((b) => canBuild(b.kind));
    const funded = opts.funding ? choices.find((b) => b.kind === opts.funding.kind && b.vertexId === opts.funding.vertexId && affordableWithTrades(you.hand, you.bankRatio, b.cost)) : void 0;
    const top = funded ?? choices[0];
    const evaluation = {
      horizon: planning.horizon.turns,
      gap: planning.gap,
      alternatives: choices.slice(0, 8).map((b) => ({ kind: b.kind, score: b.score, wait: b.wait, vertexId: b.vertexId }))
    };
    const finish = (decision) => ({ ...decision, evaluation });
    const build = (choice) => {
      var _a2;
      if (!affordableWithTrades(you.hand, you.bankRatio, choice.cost)) return null;
      const trade = tradeTowardCost(you.hand, you.bankRatio, choice.cost, planning.weights);
      if (trade && allowed("bank-trade")) return {
        kind: "bank-trade",
        trade,
        funding: { kind: choice.kind, vertexId: choice.vertexId },
        describe: `bank-trade ${trade.giveCount} ${trade.give} for ${trade.get} to fund ${choice.kind}`
      };
      if (trade) return null;
      if (choice.kind === "dev") return afford("dev") && allowed("buy-dev") ? { kind: "buy-dev", describe: "buy a development card — best progress within the remaining game" } : null;
      if (!gs || gs.youPlayer === null || !board) return null;
      const roads = ((_a2 = choice.roadEdges) == null ? void 0 : _a2.filter((id) => !gs.state.roads.some((r) => r.edgeId === id))) ?? [];
      if (roads.length) {
        if (!allowed("build-road") || !hasPiece("road")) return null;
        const edge = board.edges[roads[0]];
        const coord2 = pixelsToColonistEdge(board.vertices[edge.a], board.vertices[edge.b]);
        return coord2 ? { kind: "build-road", coord: coord2, describe: `road for funded ${choice.kind === "road" ? "Longest Road" : "settlement claim"}` } : null;
      }
      if (choice.vertexId === void 0) return null;
      const v = board.vertices[choice.vertexId];
      const coord = pixelToColonistCorner(v.x, v.y);
      if (!coord) return null;
      const kind = choice.kind === "city" ? "build-city" : "build-settlement";
      return allowed(kind) ? { kind, coord, describe: `${choice.kind} — best progress within ~${planning.horizon.turns.toFixed(1)} turns` } : null;
    };
    for (const choice of choices.filter((b) => b.kind !== "dev" && b.vp >= planning.gap && b.wait === 0)) {
      const action = build(choice);
      if (action) return finish(action);
    }
    if (knightReason) return finish({ kind: "play-knight", describe: `play a knight — ${knightReason}` });
    if (opts.hasMonopoly && allowed("play-monopoly")) {
      const opponents = [...tracker2.players.values()].filter((p) => p.name !== youName);
      const scoreHand = (hand, horizon = planning.horizon) => {
        var _a2;
        return ((_a2 = evaluateBuilds(planning.options, hand, planning.production, you.bankRatio, planning.remaining, planning.gap, horizon)[0]) == null ? void 0 : _a2.score) ?? 0;
      };
      const base = scoreHand(you.hand);
      const futureHand = Object.fromEntries(RESOURCES.map((r) => [r, you.hand[r] + planning.production[r]]));
      const laterHorizon = { ...planning.horizon, turns: Math.max(0, planning.horizon.turns - 1) };
      const futureBase = scoreHand(futureHand, laterHorizon);
      let best = null;
      let waitingValue = 0;
      for (const resource of RESOURCES) {
        const haul = confirmedMonopolyHaul(tracker2.players.values(), youName, resource);
        const next = { ...you.hand, [resource]: you.hand[resource] + haul };
        let delay = 0;
        let futureHaul = 0;
        for (const opponent of opponents) {
          const input = planning.inputs.find((p) => p.name === opponent.name);
          if (!input) continue;
          const goal = ((_d = (_c = planning.victories.find((p) => p.name === opponent.name)) == null ? void 0 : _c.steps[0]) == null ? void 0 : _d.cost) ?? BUILD_COSTS.city;
          const rate = Object.fromEntries(RESOURCES.map((r) => [r, input.production[r] * (input.rollsPerTurn ?? 2)]));
          const before = turnsToAfford(goal, opponent.hand, rate, opponent.bankRatio);
          const after = turnsToAfford(goal, { ...opponent.hand, [resource]: 0 }, rate, opponent.bankRatio);
          delay += Number.isFinite(before) ? Math.min(planning.horizon.turns + 1, Math.max(0, after - before)) : 0;
          const expected = Object.fromEntries(RESOURCES.map((r) => [r, opponent.hand[r] + rate[r]]));
          const spends = affordableWithTrades(expected, opponent.bankRatio, goal);
          futureHaul += Math.max(0, expected[resource] - (spends ? goal[resource] ?? 0 : 0));
        }
        const value = scoreHand(next) - base + delay / (1 + planning.horizon.turns);
        const survival = planning.horizon.turns / (1 + planning.horizon.turns);
        const later = scoreHand({ ...futureHand, [resource]: futureHand[resource] + futureHaul }, laterHorizon) - futureBase;
        waitingValue = Math.max(waitingValue, survival * Math.max(0, later));
        if (haul > 0 && (!best || value > best.value)) best = { resource, value, haul };
      }
      if (best && best.value > 0 && best.value + 1e-6 >= waitingValue) return finish({
        kind: "play-monopoly",
        resource: best.resource,
        describe: `play monopoly on ${best.resource} — ${best.haul} confirmed cards, more useful now than waiting`
      });
    }
    if (top && opts.hasYearOfPlenty && allowed("play-year-of-plenty")) {
      let best = null;
      for (const a of RESOURCES) for (const b of RESOURCES) {
        const hand = { ...you.hand };
        hand[a]++;
        hand[b]++;
        const after = evaluateBuilds([top], hand, planning.production, you.bankRatio, planning.remaining, planning.gap, planning.horizon)[0];
        if (after.wait < top.wait && (!best || after.score - top.score > best.improvement)) best = { resources: [a, b], improvement: after.score - top.score };
      }
      if (best && best.improvement > 0) return finish({
        kind: "play-year-of-plenty",
        resources: best.resources,
        describe: `year of plenty — ${best.resources.join(" + ")} accelerates ${top.kind}`
      });
    }
    if (opts.hasRoadBuilding && allowed("play-road-building") && hasPiece("road")) {
      const free = freeRoadChoices(Math.min(2, (pieces == null ? void 0 : pieces.roads) ?? 2))[0];
      if (free && free.score > ((top == null ? void 0 : top.score) ?? 0) && free.wait < planning.horizon.turns) {
        return finish({ kind: "play-road-building", describe: `free roads accelerate the planned ${free.kind}` });
      }
    }
    if (top) {
      const action = build(top);
      if (action) return finish(action);
      if (((_e = top.roadEdges) == null ? void 0 : _e.length) && top.wait < planning.horizon.turns && afford("road") && allowed("build-road") && hasPiece("road") && gs && board) {
        const edge = board.edges[top.roadEdges[0]];
        const coord = pixelsToColonistEdge(board.vertices[edge.a], board.vertices[edge.b]);
        if (coord) return finish({
          kind: "build-road",
          coord,
          describe: `road toward planned ${top.kind}, completable within the remaining game`
        });
      }
    }
    if (opts.canProposeTrade && top && allowed("propose-trade")) {
      const offer = proposeTrade(you.hand, [top.cost], planning.weights, { alreadyAsked: opts.askedThisTurn, handLimit: limit });
      if (offer) return finish({ kind: "propose-trade", offer, describe: "offer a trade toward the planned build" });
    }
    return allowed("end-turn") ? finish({ kind: "end-turn", describe: top ? `save for ${top.kind} (~${top.wait.toFixed(1)} turns)` : "end turn — no verified build target" }) : null;
  }
  class Autopilot {
    constructor(learner2, dispatch = () => false, domAct = (kind, exclude) => tryDomAction(kind, document, exclude), domDiscard = tryDomDiscard) {
      __publicField(this, "enabled", false);
      __publicField(this, "wsTurnSeen", false);
      __publicField(this, "robberPending", false);
      __publicField(this, "discardPending", false);
      __publicField(this, "myTurn", false);
      /** the two independent turn signals; myTurn is their OR */
      __publicField(this, "wsMine", false);
      __publicField(this, "domMine", false);
      __publicField(this, "rolledThisTurn", false);
      /** dev-card rules: one play per turn, none the turn it was bought */
      __publicField(this, "devPlayedThisTurn", false);
      __publicField(this, "devsBoughtThisTurn", 0);
      /** free roads still owed after playing Road Building */
      __publicField(this, "freeRoads", 0);
      __publicField(this, "funding");
      /** trade offer ids we've already answered this game */
      __publicField(this, "answeredOffers", /* @__PURE__ */ new Set());
      /** resources we've asked for in proposals this turn (max 2 proposals) */
      __publicField(this, "askedThisTurn", []);
      __publicField(this, "lastAsked", null);
      __publicField(this, "pending", null);
      /** DOM controls (per action) we clicked but the game never confirmed. */
      __publicField(this, "domFailed", /* @__PURE__ */ new Map());
      __publicField(this, "note", "off");
      /** Hold time for the game's first settlement placement (think it through). */
      __publicField(this, "firstSettHold", null);
      this.learner = learner2;
      this.dispatch = dispatch;
      this.domAct = domAct;
      this.domDiscard = domDiscard;
    }
    setEnabled(on) {
      this.enabled = on;
      this.note = on ? "on — waiting for your turn" : "off";
      if (!on) {
        this.pending = null;
        this.firstSettHold = null;
      }
    }
    onTurnState(currentColor, myColor) {
      this.wsTurnSeen = true;
      this.wsMine = myColor !== null && currentColor === myColor;
      this.recomputeTurn();
    }
    /**
     * DOM turn signal from colonist's "Your Turn" banner. Runs EVERY tick, not
     * only as a WS fallback: colonist's turn-state color ids don't always line
     * up with our detected `myColor` (or myColor may never arrive), and when
     * they don't, the WS signal alone would leave autopilot thinking it's never
     * our turn. The banner is authoritative for the local player — colonist only
     * shows it to you on your own turn — so we OR it with the WS signal.
     */
    noteDomTurn(mine) {
      this.domMine = mine;
      this.recomputeTurn();
    }
    /** Fold the WS and DOM turn signals; reset per-turn state on the rising edge. */
    recomputeTurn() {
      var _a;
      const mine = this.wsMine || this.domMine;
      if (mine && !this.myTurn) {
        this.rolledThisTurn = false;
        this.devPlayedThisTurn = false;
        this.devsBoughtThisTurn = 0;
        this.freeRoads = 0;
        this.funding = void 0;
        this.askedThisTurn = [];
        this.domFailed.clear();
      }
      if (!mine && this.myTurn && ((_a = this.pending) == null ? void 0 : _a.kind) === "end-turn") this.pending = null;
      this.myTurn = mine;
    }
    onYouRolled() {
      var _a;
      this.rolledThisTurn = true;
      if (((_a = this.pending) == null ? void 0 : _a.kind) === "roll") this.pending = null;
    }
    onConfirm(kind) {
      var _a;
      if (((_a = this.pending) == null ? void 0 : _a.kind) === kind) this.pending = null;
      if (kind === "move-robber") this.robberPending = false;
      if (kind === "discard") this.discardPending = false;
      if (kind === "play-knight" || kind === "play-monopoly" || kind === "play-road-building" || kind === "play-year-of-plenty") {
        this.devPlayedThisTurn = true;
      }
      if (kind === "play-road-building") this.freeRoads = 2;
      if (kind === "propose-trade" && this.lastAsked) this.askedThisTurn.push(this.lastAsked);
      if (kind === "build-road" && this.freeRoads > 0) this.freeRoads--;
      if (kind === "buy-dev") this.devsBoughtThisTurn++;
      if (kind === "end-turn" || this.funding && kind === (this.funding.kind === "dev" ? "buy-dev" : `build-${this.funding.kind}`)) this.funding = void 0;
    }
    /** A non-knight dev card was played manually (YoP, Monopoly, Road Building). */
    markDevPlayed() {
      this.devPlayedThisTurn = true;
    }
    /** A 7 was rolled or a knight played — the current player must move the robber. */
    setRobberPending(pending) {
      this.robberPending = pending;
    }
    /** The game is asking for discards (a 7 while someone is over the limit). */
    setDiscardPending(pending) {
      this.discardPending = pending;
    }
    view() {
      return { enabled: this.enabled, status: this.learner.status(), note: this.note };
    }
    tick(ctx) {
      var _a, _b, _c, _d, _e, _f;
      const vpCardsHeld = (ctx.myDevCardIds ?? []).filter((id) => id === 12).length;
      if (!this.enabled) return;
      const now = ctx.now ?? Date.now();
      const you0 = ((_a = ctx.tracker) == null ? void 0 : _a.youName) ? ctx.tracker.players.get(ctx.tracker.youName) : void 0;
      for (const offer of ctx.tradeOffers ?? []) {
        if (this.answeredOffers.has(offer.id) || !you0) continue;
        const plan = ((_b = ctx.planning) == null ? void 0 : _b.builds.map((b) => b.cost)) ?? planCosts(ctx.fit, visibleVp(you0), ctx.winTarget ?? 10);
        const verdict = decideTradeResponse(you0.hand, offer, plan, ((_c = ctx.tracker) == null ? void 0 : _c.discardLimit) ?? 7);
        const decision2 = {
          kind: "trade-response",
          tradeId: offer.id,
          accept: verdict.accept,
          describe: `${verdict.accept ? "accept" : "decline"} trade — ${verdict.reason}`
        };
        this.answeredOffers.add(offer.id);
        if (this.answeredOffers.size > 200) this.answeredOffers.clear();
        if (this.dispatch(decision2)) {
          this.note = `acting: ${decision2.describe}`;
          return;
        }
        this.note = `▶ ${decision2.describe} (answer it manually — response frame not learned yet)`;
      }
      if (this.pending) {
        if (now - this.pending.t > 8e3) {
          if (this.pending.via === "ws") {
            this.learner.discard(this.pending.kind);
            this.note = `"${this.pending.kind}" wasn't confirmed — template discarded, do it manually once to re-learn`;
          } else {
            if (this.pending.label && this.pending.kind !== "discard") {
              const kind = this.pending.kind;
              const failed = this.domFailed.get(kind) ?? /* @__PURE__ */ new Set();
              failed.add(this.pending.label);
              this.domFailed.set(kind, failed);
            }
            this.note = `clicked "${this.pending.label ?? this.pending.kind}" but the game didn't react — trying another control`;
          }
          this.pending = null;
        }
        return;
      }
      const robberMine = this.robberPending && (this.myTurn || !this.wsTurnSeen);
      const you = ((_d = ctx.tracker) == null ? void 0 : _d.youName) ? ctx.tracker.players.get(ctx.tracker.youName) : void 0;
      const mustDiscard = this.discardPending && !!you && handTotal(you) > (((_e = ctx.tracker) == null ? void 0 : _e.discardLimit) ?? 9);
      if (!robberMine && !mustDiscard && (!this.myTurn || !ctx.tracker || !ctx.tracker.youName)) {
        const sig = this.domMine ? "banner" : this.wsMine ? "ws" : "none";
        this.note = `on — waiting for your turn (signal: ${sig})`;
        return;
      }
      if (!ctx.tracker || !ctx.tracker.youName) return;
      const decision = decideNext({
        tracker: ctx.tracker,
        youName: ctx.tracker.youName,
        fit: ctx.fit,
        gs: ctx.gs,
        advice: ctx.advice,
        rolledThisTurn: this.rolledThisTurn,
        robberPending: robberMine,
        robberHex: ctx.robberHex,
        discardPending: mustDiscard,
        // Knights held (dev-card id 11, from ground-truth state) beyond any dev
        // bought this turn (a fresh buy can't be played), and no dev played yet.
        knightAvailable: !this.devPlayedThisTurn && ((ctx.myDevCardIds ?? []).filter((id) => id === 11).length || (ctx.knightsInHand ?? 0)) > this.devsBoughtThisTurn,
        bankDevCards: ctx.bankDevCards,
        piecesLeft: ctx.piecesLeft,
        // Playable only if we hold the card, haven't played a dev this turn, and
        // hold more than we bought this turn (a fresh buy can't be played).
        // 13 = monopoly, 14 = road building, 15 = year of plenty.
        hasMonopoly: !this.devPlayedThisTurn && (ctx.myDevCardIds ?? []).filter((id) => id === 13).length > this.devsBoughtThisTurn,
        hasRoadBuilding: !this.devPlayedThisTurn && (ctx.myDevCardIds ?? []).filter((id) => id === 14).length > this.devsBoughtThisTurn,
        hasYearOfPlenty: !this.devPlayedThisTurn && (ctx.myDevCardIds ?? []).filter((id) => id === 15).length > this.devsBoughtThisTurn,
        freeRoadsPending: this.freeRoads,
        canRob: ctx.canRob,
        winTarget: ctx.winTarget,
        planning: ctx.planning,
        funding: this.funding,
        vpCardsHeld,
        canProposeTrade: (ctx.playerCount ?? 2) >= 3 && this.askedThisTurn.length < 2,
        askedThisTurn: this.askedThisTurn
      });
      if ((decision == null ? void 0 : decision.kind) === "propose-trade" && decision.offer) {
        this.lastAsked = Object.keys(decision.offer.wanted)[0] ?? null;
      }
      if (!decision) {
        this.note = robberMine ? "on — move the robber manually (board not captured or no good tile)" : "on — nothing to do";
        return;
      }
      if (decision.kind === "build-settlement" && (((_f = ctx.gs) == null ? void 0 : _f.state.buildings.length) ?? 1) === 0) {
        if (this.firstSettHold === null) {
          this.firstSettHold = now + FIRST_SETTLEMENT_THINK_MS;
          this.note = "thinking about the best opening spot…";
          return;
        }
        if (now < this.firstSettHold) {
          this.note = `thinking about the best opening spot… (${Math.ceil((this.firstSettHold - now) / 1e3)}s)`;
          return;
        }
        this.firstSettHold = null;
      }
      if (decision.kind === "play-monopoly" && (!decision.resource || confirmedMonopolyHaul(ctx.tracker.players.values(), ctx.tracker.youName, decision.resource) <= 0)) {
        this.note = "holding Monopoly — resource holdings are not confirmed";
        return;
      }
      if (this.dispatch(decision)) {
        if (decision.funding) this.funding = decision.funding;
        this.pending = { kind: decision.kind, t: now, via: "ws" };
        this.note = `acting: ${decision.describe}`;
        return;
      }
      if (decision.kind === "roll" || decision.kind === "end-turn" || decision.kind === "buy-dev") {
        const clicked = this.domAct(decision.kind, this.domFailed.get(decision.kind));
        if (clicked) {
          this.pending = { kind: decision.kind, t: now, via: "dom", label: clicked };
          this.note = `acting: ${decision.describe} (clicked game button)`;
          return;
        }
      }
      if (decision.kind === "discard" && decision.cards) {
        const clicked = this.domDiscard(decision.cards);
        if (clicked) {
          this.pending = { kind: "discard", t: now, via: "dom" };
          this.note = `acting: ${decision.describe} (clicked the discard dialog)`;
          return;
        }
      }
      const spatial = decision.kind === "build-settlement" || decision.kind === "build-road" || decision.kind === "build-city" || decision.kind === "move-robber";
      this.note = spatial ? `▶ Your click: ${decision.describe} — highlighted ① on the map above (board clicks aren't automated)` : decision.kind === "discard" ? `on — pick the discards manually once (${decision.describe}) so I can learn it` : decision.kind === "play-knight" ? `on — play a knight manually once so I can learn it (${decision.describe})` : decision.kind === "play-road-building" || decision.kind === "play-year-of-plenty" ? `on — ${decision.describe} (couldn't send it — play the card manually)` : `on — "${decision.kind}" not learned yet, do it manually once`;
    }
  }
  const STORAGE_KEY$1 = "catanCopilot:games";
  function loadRecords() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY$1) ?? "[]");
    } catch {
      return [];
    }
  }
  function recordGameEnd(state) {
    if (state.gameOver === false || !state.youName) return null;
    const you = state.players.get(state.youName);
    if (!you) return null;
    const topVp = Math.max(0, ...[...state.players.values()].map((p) => visibleVp(p)));
    if (topVp < 5) return null;
    const prod = expectedProduction(you);
    let best = STRATEGIES[0];
    let bestScore = -Infinity;
    for (const s of STRATEGIES) {
      const score = RESOURCES.reduce((sum2, r) => sum2 + prod[r] * s.weights[r], 0);
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    const rec = {
      at: Date.now(),
      win: state.gameOver === state.youName,
      strategyId: best.id,
      players: state.players.size
    };
    try {
      const all = loadRecords();
      all.push(rec);
      localStorage.setItem(STORAGE_KEY$1, JSON.stringify(all.slice(-100)));
    } catch {
    }
    return rec;
  }
  function strategyPriors(records) {
    const out = {};
    for (const s of STRATEGIES) {
      const rel = records.filter((r) => r.strategyId === s.id);
      const wins = rel.filter((r) => r.win).length;
      const losses = rel.length - wins;
      const nudge = 0.08 * (wins - losses) / Math.max(3, rel.length);
      out[s.id] = Math.min(1.15, Math.max(0.85, 1 + nudge));
    }
    return out;
  }
  function recordStats(records) {
    if (records.length === 0) return null;
    const sorted = [...records].sort((a, b) => a.at - b.at);
    const wins = sorted.filter((r) => r.win).length;
    const recent = sorted.slice(-10).map((r) => r.win);
    let streak = 0;
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (sorted[i].win !== sorted[sorted.length - 1].win) break;
      streak++;
    }
    if (!sorted[sorted.length - 1].win) streak = -streak;
    const group = (key) => {
      const m = /* @__PURE__ */ new Map();
      for (const r of sorted) {
        const g = m.get(key(r)) ?? { games: 0, wins: 0 };
        g.games++;
        if (r.win) g.wins++;
        m.set(key(r), g);
      }
      return m;
    };
    const byStrategy = [...group((r) => r.strategyId)].map(([strategyId, g]) => {
      var _a;
      return {
        strategyId,
        name: ((_a = STRATEGIES.find((s) => s.id === strategyId)) == null ? void 0 : _a.name) ?? strategyId,
        ...g,
        winRate: g.wins / g.games
      };
    }).sort((a, b) => b.games - a.games);
    const byPlayers = [...group((r) => r.players)].map(([players, g]) => ({ players, ...g, winRate: g.wins / g.games })).sort((a, b) => a.players - b.players);
    return {
      games: sorted.length,
      wins,
      losses: sorted.length - wins,
      winRate: wins / sorted.length,
      recent,
      streak,
      byStrategy,
      byPlayers
    };
  }
  const VERSION = "v1.20 legal-trades-race";
  const CSS = `
#catan-copilot {
  --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --ink-3: #898781;
  --hairline: #e1e0d9; --accent: #4a3aa7; --bar: #2a78d6;
  --brick: #b5432a; --wheat: #e2a41a; --sheep: #58b47a; --ore: #4f6bb0; --wood: #268c46;
  --desert: #d8cba0; --gold: #b8860b;
  position: fixed; top: 70px; right: 12px; width: 320px; max-height: 82vh;
  z-index: 2147483000; background: var(--surface); color: var(--ink);
  border: 1px solid var(--hairline); border-radius: 10px;
  box-shadow: 0 6px 24px rgba(0,0,0,0.25);
  font: 12px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  display: flex; flex-direction: column;
}
@media (prefers-color-scheme: dark) {
  #catan-copilot {
    --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7; --ink-3: #898781;
    --hairline: #2c2c2a; --accent: #9085e9; --bar: #3987e5;
    --brick: #df6350; --wheat: #8d610b; --sheep: #47a76b; --ore: #6f89cc; --wood: #2f9e55;
    --desert: #55503e; --gold: #d4a017;
  }
}
/* Docked: a full-height column on the left edge; the page is narrowed by
   the same width (html.cc-docked-page) so the game sits BESIDE the panel
   instead of underneath it. */
#catan-copilot.cc-docked {
  top: 0 !important; left: 0 !important; right: auto !important; bottom: 0;
  width: var(--cc-dock-w); height: 100vh; max-height: 100vh;
  border-radius: 0; border-width: 0 1px 0 0; box-shadow: 4px 0 18px rgba(0,0,0,.18);
}
#catan-copilot.cc-docked header { cursor: default; }
html.cc-docked-page {
  margin-left: var(--cc-dock-w) !important;
  width: calc(100% - var(--cc-dock-w)) !important;
  overflow-x: hidden;
}
#catan-copilot header {
  display: flex; align-items: center; gap: 8px; padding: 8px 12px;
  border-bottom: 1px solid var(--hairline); cursor: grab; user-select: none;
}
#catan-copilot header strong { font-size: 13px; }
#catan-copilot header .cc-ver {
  flex: 1; font-size: 10px; font-weight: 700; color: var(--accent);
  background: rgba(74,58,167,.12); border-radius: 8px; padding: 1px 7px; margin-left: 2px;
  white-space: nowrap;
}
#catan-copilot header button {
  background: none; border: none; color: var(--ink-2); cursor: pointer;
  font-size: 13px; padding: 2px 6px;
}
#catan-copilot .cc-body { overflow-y: auto; padding: 10px 12px 12px; }
#catan-copilot h4 {
  margin: 12px 0 6px; font-size: 11px; text-transform: uppercase;
  letter-spacing: .06em; color: var(--ink-3);
}
#catan-copilot h4:first-child { margin-top: 0; }
#catan-copilot .cc-note { color: var(--ink-2); margin: 3px 0; }
#catan-copilot .cc-muted { color: var(--ink-3); }
#catan-copilot .cc-eval { display: flex; align-items: center; gap: 6px; margin: 4px 0; }
#catan-copilot .cc-eval-you, #catan-copilot .cc-eval-opp {
  font-size: 12px; font-weight: 700; min-width: 34px; text-align: center;
  font-variant-numeric: tabular-nums;
}
#catan-copilot .cc-eval-you { color: var(--accent); }
#catan-copilot .cc-eval-opp { color: var(--brick); }
#catan-copilot .cc-eval-bar {
  flex: 1; height: 10px; border-radius: 5px; overflow: hidden;
  background: color-mix(in srgb, var(--brick) 35%, transparent);
  border: 1px solid var(--hairline);
}
#catan-copilot .cc-eval-fill { height: 100%; background: var(--bar); transition: width .3s; }
#catan-copilot ul.cc-eval-why { margin: 2px 0 6px 16px; padding: 0; }
#catan-copilot .cc-deck { display: grid; grid-template-columns: repeat(11, 1fr); gap: 3px; align-items: end; }
#catan-copilot .cc-deck .col { text-align: center; }
#catan-copilot .cc-deck .bar {
  width: 100%; background: var(--bar); border-radius: 3px 3px 0 0; margin: 0 auto;
  min-height: 2px;
}
#catan-copilot .cc-deck .bar.cold { opacity: .25; }
#catan-copilot .cc-deck .n { color: var(--ink-2); margin-top: 2px; }
#catan-copilot .cc-deck .n.due { color: var(--ink); font-weight: 700; }
#catan-copilot .cc-deck .c { color: var(--ink-3); font-variant-numeric: tabular-nums; }
#catan-copilot table { width: 100%; border-collapse: collapse; }
#catan-copilot td, #catan-copilot th {
  padding: 2px 4px; text-align: right; font-variant-numeric: tabular-nums;
}
#catan-copilot th { color: var(--ink-3); font-weight: 500; }
#catan-copilot td:first-child, #catan-copilot th:first-child { text-align: left; }
#catan-copilot .dot {
  display: inline-block; width: 8px; height: 8px; border-radius: 50%;
  margin-right: 5px; border: 1px solid rgba(128,128,128,.5); vertical-align: 0;
}
#catan-copilot .cc-card {
  border: 1px solid var(--hairline); border-radius: 8px; padding: 8px 10px; margin: 6px 0;
}
#catan-copilot .cc-card.rec { border-color: var(--accent); border-width: 2px; }
#catan-copilot .cc-card .t { font-weight: 600; display: flex; justify-content: space-between; }
#catan-copilot .cc-card .tag { color: var(--ink-2); }
#catan-copilot .cc-card ul { margin: 4px 0 0; padding-left: 16px; color: var(--ink-2); }
#catan-copilot .cc-badge {
  background: var(--accent); color: #fff; border-radius: 8px; padding: 0 6px;
  font-size: 10px; font-weight: 700;
}
/* Hand grid: five FIXED slots (wood, brick, sheep, wheat, ore) so a count is
   always in the same place and reads at a glance; zero slots stay visible
   but dimmed. Icons are shapes, not colour alone, so they read with any
   colour vision. */
#catan-copilot .cc-hand {
  display: grid; grid-template-columns: repeat(5, minmax(44px, 1fr));
  gap: 4px; max-width: 300px; margin: 2px 0 4px;
}
#catan-copilot .cc-slot {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 6px 2px 3px; border-radius: 6px;
  background: rgba(127,127,127,.10); border: 1px solid rgba(127,127,127,.18);
  font-variant-numeric: tabular-nums; font-weight: 700; font-size: 12px;
  color: var(--ink);
}
#catan-copilot .cc-slot svg { width: 18px; height: 18px; flex: none; display: block; }
#catan-copilot .cc-slot.zero { opacity: .38; font-weight: 500; }
/* Record card: stat tiles + win-rate bar + recent-form dots. Wins use the
   bar blue, losses the hairline grey — both are direct-labeled. */
#catan-copilot .cc-record { margin-top: 6px; }
#catan-copilot .cc-tiles { display: grid; grid-template-columns: 1.4fr 1fr 1fr; gap: 6px; margin: 4px 0 6px; }
#catan-copilot .cc-tile {
  border: 1px solid var(--hairline); border-radius: 8px; padding: 6px 8px; text-align: center;
  background: rgba(127,127,127,.06);
}
#catan-copilot .cc-tile .v { font-size: 18px; font-weight: 800; line-height: 1.1; font-variant-numeric: tabular-nums; }
#catan-copilot .cc-tile .k { font-size: 10px; color: var(--ink-2); text-transform: uppercase; letter-spacing: .04em; margin-top: 2px; }
#catan-copilot .cc-tile.hero { background: rgba(42,120,214,.10); border-color: rgba(42,120,214,.35); }
#catan-copilot .cc-tile.hero .v { color: var(--bar); font-size: 22px; }
#catan-copilot .cc-tile.win .v { color: var(--bar); }
#catan-copilot .cc-tile.loss .v { color: var(--ink-2); }
#catan-copilot .cc-ratebar {
  height: 8px; border-radius: 4px; background: var(--hairline); overflow: hidden; margin: 0 0 6px;
}
#catan-copilot .cc-ratebar span { display: block; height: 100%; background: var(--bar); border-radius: 4px; }
#catan-copilot .cc-form .dot {
  display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin: 0 1.5px; vertical-align: -1px;
  border: 1.5px solid var(--bar); box-sizing: border-box;
}
#catan-copilot .cc-form .dot.win { background: var(--bar); }
#catan-copilot .cc-form .dot.loss { border-color: var(--ink-3); background: transparent; }
#catan-copilot .cc-split { margin: 4px 0; }
#catan-copilot .cc-split { width: 100%; }
#catan-copilot .cc-split td, #catan-copilot .cc-split th { text-align: left; white-space: nowrap; padding-right: 6px; }
#catan-copilot .cc-split td:first-child { font-size: 11px; max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
#catan-copilot .cc-rate {
  position: relative; height: 14px; border-radius: 3px; background: var(--hairline); overflow: hidden;
}
#catan-copilot .cc-rate span { display: block; height: 100%; background: var(--bar); opacity: .55; }
#catan-copilot .cc-rate em {
  position: absolute; inset: 0; font-style: normal; font-size: 10px; font-weight: 700;
  line-height: 14px; padding-left: 4px; color: var(--ink); font-variant-numeric: tabular-nums;
}
#catan-copilot .cc-wtable { width: 100%; border-collapse: collapse; }
#catan-copilot .cc-wtable td { padding: 1px 4px 1px 0; vertical-align: middle; }
#catan-copilot .cc-wname { font-weight: 700; white-space: nowrap; }
#catan-copilot .cc-wpath { padding-bottom: 5px; font-size: 11px; }
#catan-copilot .cc-wtable tr.you .cc-wname { color: var(--accent); }
#catan-copilot .cc-wtable tr.out { opacity: .5; }
#catan-copilot .cc-wbar, #catan-copilot .cc-wbar em { position: relative; }
#catan-copilot .cc-wbar {
  height: 15px; border-radius: 3px; background: var(--hairline); overflow: hidden;
}
#catan-copilot .cc-wbar span { display: block; height: 100%; background: var(--bar); opacity: .6; }
#catan-copilot .cc-wbar em {
  position: absolute; inset: 0; font-style: normal; font-size: 10px; font-weight: 800;
  line-height: 15px; padding-left: 5px; color: var(--ink); font-variant-numeric: tabular-nums;
}
#catan-copilot .cc-bar em { font-style: normal; }
#catan-copilot .cc-bar {
  height: 15px; border-radius: 3px; background: var(--hairline); text-align: center;
  font-size: 10px; line-height: 15px; color: var(--ink-3);
}
#catan-copilot-toggle {
  position: fixed; top: 70px; right: 12px; z-index: 2147483001;
  background: #4a3aa7; color: #fff; border: none; border-radius: 16px;
  padding: 5px 12px; font: 600 12px system-ui, sans-serif; cursor: pointer;
  display: none;
}
#catan-copilot .cc-hist {
  max-height: 176px; overflow-y: auto; border: 1px solid var(--hairline);
  border-radius: 8px; padding: 2px 8px; margin-top: 4px;
}
#catan-copilot .cc-hist .row {
  display: flex; gap: 6px; padding: 2px 4px; font-size: 12px; line-height: 1.35;
  border-bottom: 1px solid var(--hairline);
}
#catan-copilot .cc-hist .row:last-child { border-bottom: none; }
#catan-copilot .cc-hist .who { color: var(--ink-2); font-weight: 600; white-space: nowrap; }
#catan-copilot .cc-hist .row.mine { border-radius: 4px; background: rgba(74,58,167,.08); }
#catan-copilot .cc-hist .row.mine .who { color: var(--accent); }
#catan-copilot .cc-hist .what { color: var(--ink-2); }
#catan-copilot .cc-h4row { display: flex; align-items: baseline; justify-content: space-between; }
#catan-copilot .cc-h4row button { font-size: 11px; padding: 1px 7px; }
`;
  function esc(s) {
    return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  }
  const HAND_ORDER = ["wood", "brick", "sheep", "wheat", "ore"];
  const RESOURCE_ICON = {
    wood: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="10.4" y="15" width="3.2" height="7" rx="1" fill="#6b4423"/>
    <path d="M12 2 L5.5 11 H9 L4.5 17.5 H19.5 L15 11 H18.5 Z" fill="#2f8f4e"/>
    <path d="M12 2 L9 6.5 H11.5 L8.5 11 H12 Z" fill="#47b36a" opacity=".8"/>
  </svg>`,
    brick: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="2" y="4" width="9" height="4.6" rx=".6" fill="#c4452b"/>
    <rect x="12.5" y="4" width="9.5" height="4.6" rx=".6" fill="#b23c24"/>
    <rect x="6.5" y="9.7" width="10" height="4.6" rx=".6" fill="#c4452b"/>
    <rect x="2" y="9.7" width="3.5" height="4.6" rx=".6" fill="#b23c24"/>
    <rect x="17.5" y="9.7" width="4.5" height="4.6" rx=".6" fill="#b23c24"/>
    <rect x="2" y="15.4" width="9" height="4.6" rx=".6" fill="#b23c24"/>
    <rect x="12.5" y="15.4" width="9.5" height="4.6" rx=".6" fill="#c4452b"/>
  </svg>`,
    sheep: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <g fill="#f3f1ea" stroke="#5f5f57" stroke-width="1">
      <circle cx="8" cy="11" r="3.6"/><circle cx="12.5" cy="9" r="3.8"/>
      <circle cx="16.5" cy="11.5" r="3.4"/><circle cx="10" cy="14.5" r="3.6"/>
      <circle cx="14.5" cy="14.8" r="3.6"/>
    </g>
    <rect x="9" y="17" width="1.8" height="4" rx=".6" fill="#3c3630"/>
    <rect x="14" y="17" width="1.8" height="4" rx=".6" fill="#3c3630"/>
    <ellipse cx="18.6" cy="12.6" rx="2.6" ry="2.2" fill="#3c3630"/>
    <circle cx="19.4" cy="12.1" r=".5" fill="#fff"/>
    <path d="M16.4 11.2 l-1.1-1.6 M20.8 11.2 l1.1-1.6" stroke="#3c3630" stroke-width="1" stroke-linecap="round"/>
  </svg>`,
    wheat: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 22 V7" stroke="#b8860b" stroke-width="1.6" stroke-linecap="round"/>
    <g fill="#e8b320" stroke="#a87408" stroke-width=".5">
      <ellipse cx="9.6" cy="9" rx="1.7" ry="3" transform="rotate(-30 9.6 9)"/>
      <ellipse cx="14.4" cy="9" rx="1.7" ry="3" transform="rotate(30 14.4 9)"/>
      <ellipse cx="9.4" cy="13" rx="1.7" ry="3" transform="rotate(-30 9.4 13)"/>
      <ellipse cx="14.6" cy="13" rx="1.7" ry="3" transform="rotate(30 14.6 13)"/>
      <ellipse cx="12" cy="5" rx="1.7" ry="3"/>
    </g>
    <path d="M12 18 c-2.5-.2-4-1.8-4.5-3.5 2.3.1 4 1.4 4.5 3.5z" fill="#7cae3e"/>
  </svg>`,
    ore: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 17 L8 7 L13 4 L20 9 L21 16 L16 21 L7 21 Z" fill="#6b7280" stroke="#3f4650" stroke-width=".8" stroke-linejoin="round"/>
    <path d="M8 7 L13 11 L20 9 M13 11 L11 21 M13 11 L21 16" fill="none" stroke="#3f4650" stroke-width=".7"/>
    <path d="M13 4 L16 8 L13 11 L10 8 Z" fill="#9aa3ad" opacity=".7"/>
    <circle cx="16.5" cy="15" r="1.4" fill="#8fb3ff" opacity=".9"/>
  </svg>`
  };
  const DOCK_PREF = "catanCopilot:docked";
  function loadDockPref() {
    try {
      return localStorage.getItem(DOCK_PREF) === "1";
    } catch {
      return false;
    }
  }
  function saveDockPref(on) {
    try {
      localStorage.setItem(DOCK_PREF, on ? "1" : "0");
    } catch {
    }
  }
  class Overlay {
    constructor(doc, hooks = {}) {
      __publicField(this, "root");
      __publicField(this, "body");
      __publicField(this, "deferredRender");
      __publicField(this, "lastState", null);
      __publicField(this, "lastBridge", null);
      /** docked = full-height column beside the game; floating = draggable card */
      __publicField(this, "docked", false);
      __publicField(this, "toggle");
      __publicField(this, "hooks");
      this.hooks = hooks;
      const style = doc.createElement("style");
      style.textContent = CSS;
      doc.head.appendChild(style);
      this.root = doc.createElement("div");
      this.root.id = "catan-copilot";
      this.root.innerHTML = `
      <header>
        <strong>Catan Copilot</strong>
        <span class="cc-ver">${esc(VERSION)}</span>
        <button data-act="dock" title="Dock the panel beside the game (instead of floating over it)">Dock</button>
        <button data-act="hide" title="Hide">–</button>
      </header>
      <div class="cc-body"><p class="cc-note">Waiting for game log…</p></div>`;
      doc.body.appendChild(this.root);
      this.toggle = doc.createElement("button");
      this.toggle.id = "catan-copilot-toggle";
      this.toggle.textContent = "Copilot";
      doc.body.appendChild(this.toggle);
      this.body = this.root.querySelector(".cc-body");
      this.root.querySelector('[data-act="hide"]').addEventListener("click", () => {
        this.root.style.display = "none";
        this.toggle.style.display = "block";
      });
      this.root.querySelector('[data-act="dock"]').addEventListener("click", () => {
        this.setDocked(!this.docked);
      });
      this.setDocked(loadDockPref(), false);
      this.root.addEventListener("click", (e) => {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        const target = e.target;
        if (target.closest('[data-act="download-capture"]')) {
          (_b = (_a = this.hooks).onDownloadCapture) == null ? void 0 : _b.call(_a);
        }
        if (target.closest('[data-act="download-history"]')) {
          (_d = (_c = this.hooks).onDownloadHistory) == null ? void 0 : _d.call(_c);
        }
        if (target.closest('[data-act="download-gamelogs"]')) {
          (_f = (_e = this.hooks).onDownloadGameLogs) == null ? void 0 : _f.call(_e);
        }
        const toggle = target.closest('[data-act="toggle-autopilot"]');
        if (toggle) {
          (_h = (_g = this.hooks).onToggleAutopilot) == null ? void 0 : _h.call(_g, toggle.checked);
        }
      });
      this.root.addEventListener("change", (e) => {
        var _a, _b;
        const rush = e.target.closest('[data-act="rush-pref"]');
        if (rush) (_b = (_a = this.hooks).onSetRushPref) == null ? void 0 : _b.call(_a, rush.value);
      });
      this.toggle.addEventListener("click", () => {
        this.root.style.display = "flex";
        this.toggle.style.display = "none";
      });
      this.makeDraggable(doc);
    }
    /**
     * Dock beside the game or float over it. Docking narrows the page by the
     * panel's width and fires a resize so the game re-lays out into the
     * remaining space. (Games that size their canvas from window.innerWidth
     * ignore the page width — then the panel still overlaps their right edge,
     * but at least sits flush and full-height.)
     */
    setDocked(on, persist = true) {
      this.docked = on;
      const html = this.root.ownerDocument.documentElement;
      const DOCK_W = "340px";
      html.style.setProperty("--cc-dock-w", DOCK_W);
      this.root.classList.toggle("cc-docked", on);
      html.classList.toggle("cc-docked-page", on);
      if (on) {
        this.root.style.left = "";
        this.root.style.top = "";
      }
      const btn = this.root.querySelector('[data-act="dock"]');
      if (btn) {
        btn.textContent = on ? "Undock" : "Dock";
        btn.setAttribute("title", on ? "Float the panel over the game again" : "Dock the panel beside the game (instead of floating over it)");
      }
      if (persist) saveDockPref(on);
      const win = this.root.ownerDocument.defaultView;
      win == null ? void 0 : win.dispatchEvent(new Event("resize"));
    }
    makeDraggable(doc) {
      const header = this.root.querySelector("header");
      let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
      header.addEventListener("mousedown", (e) => {
        if (this.docked) return;
        dragging = true;
        sx = e.clientX;
        sy = e.clientY;
        const rect = this.root.getBoundingClientRect();
        ox = rect.left;
        oy = rect.top;
        e.preventDefault();
      });
      doc.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        this.root.style.left = `${ox + e.clientX - sx}px`;
        this.root.style.top = `${oy + e.clientY - sy}px`;
        this.root.style.right = "auto";
      });
      doc.addEventListener("mouseup", () => dragging = false);
    }
    render(state, bridge2) {
      var _a, _b, _c, _d;
      const active = this.root.ownerDocument.activeElement;
      if (active && this.root.contains(active) && /^(SELECT|INPUT|TEXTAREA|OPTION)$/.test(active.tagName)) {
        if (this.deferredRender === void 0) {
          this.deferredRender = this.root.ownerDocument.defaultView.setTimeout(() => {
            this.deferredRender = void 0;
            this.render(this.lastState ?? state, this.lastBridge ?? bridge2);
          }, 500);
        }
        this.lastState = state;
        this.lastBridge = bridge2 ?? null;
        return;
      }
      this.lastState = state;
      this.lastBridge = bridge2 ?? null;
      const parts = [];
      let gs = null;
      let advice = null;
      if (bridge2 == null ? void 0 : bridge2.board) {
        gs = bridge2.toGameState();
        if (gs) advice = advisePlacement(gs.state, gs.youPlayer, state.players.size);
      }
      const planning = ((_b = (_a = this.hooks).getPlanning) == null ? void 0 : _b.call(_a)) ?? null;
      if (planning && gs && advice) advice = planningAdvice(advice, planning, gs.state);
      const you = state.youName;
      const fits = you && state.players.has(you) ? rankLiveStrategies(state, you, strategyPriors(loadRecords())) : [];
      const evalHtml = this.renderEval(state, bridge2 ?? null);
      let moveHtml = "";
      if (you && fits.length > 0) {
        let facts = null;
        if (gs && gs.youPlayer !== null) {
          facts = placementFacts(gs.state, gs.youPlayer, advice);
        }
        const inSetup = (advice == null ? void 0 : advice.phase) === "setup" || state.rolls.length === 0;
        if (!inSetup) {
          const top = planning == null ? void 0 : planning.builds[0];
          moveHtml = this.renderYourMove(top ? [{
            primary: true,
            text: `${top.wait === 0 ? "Fund" : "Save for"} ${top.kind}${top.vertexId !== void 0 ? ` at intersection ${top.vertexId}` : ""} — ~${top.wait.toFixed(1)} turns to fund; race horizon ~${planning.horizon.turns.toFixed(1)} turns.`
          }] : nextMoves(state, you, fits[0], facts));
        }
      }
      parts.push(this.renderWhereToBuild(bridge2 ?? null, gs, advice));
      if (moveHtml) parts.push(moveHtml);
      parts.push(this.renderPlayers(state));
      parts.push(this.renderDeck(deckStatus(state), state));
      if (evalHtml) parts.push(evalHtml);
      parts.push(this.renderWinChances());
      if (you && fits.length > 0) {
        if (planning) {
          const mine = planning.victories.find((p) => p.isYou);
          parts.push(`<h4>Plan to finish</h4><p class="cc-note">${esc((mine == null ? void 0 : mine.summary) ?? "Building production while a route opens")}</p>`);
        } else parts.push(this.renderStrategies(fits));
        const tile = planning && gs && gs.youPlayer !== null ? bestRobberHex(
          gs.state,
          gs.youPlayer,
          (bridge2 == null ? void 0 : bridge2.robberHex) ?? null,
          void 0,
          void 0,
          void 0,
          planning
        ) : null;
        const robber = tile ? { reason: tile.describe } : robberAdvice(state);
        if (robber) {
          parts.push(`<h4>Robber</h4><p class="cc-note">${esc(robber.reason)}</p>`);
        }
        const tips = planning ? [] : tradeTips(state, you, fits[0]);
        if (tips.length) parts.push(this.renderTrades(tips, isOneVsOne(state)));
      } else {
        parts.push(
          `<h4>You</h4><p class="cc-note cc-muted">Sign-in name not detected yet — strategy advice appears once you're identified.</p>`
        );
      }
      if (state.gameOver) {
        parts.push(`<p class="cc-note"><strong>${esc(state.gameOver)}</strong> won the game.</p>`);
      }
      if ((_d = (_c = this.hooks).needsRefresh) == null ? void 0 : _d.call(_c)) {
        parts.push(
          `<p class="cc-note" style="color:var(--brick);font-weight:600">⟳ Reload this tab! The game socket isn't captured — exact hands, the board map and full autopilot need it. (Colonist resends everything on refresh.)</p>`
        );
      }
      parts.push(this.renderRush(), this.renderHistory(), this.renderAfterGame());
      parts.unshift(this.renderAutopilot());
      this.body.innerHTML = parts.join("");
    }
    renderHistory() {
      var _a, _b;
      const hist = ((_b = (_a = this.hooks).getHistory) == null ? void 0 : _b.call(_a)) ?? [];
      if (hist.length === 0) return "";
      const rows = hist.slice(-60).reverse().map(
        (e) => `<div class="row${e.mine ? " mine" : ""}"><span class="who">${esc(e.player ?? "?")}</span><span class="what">${esc(e.text)}</span></div>`
      ).join("");
      return `
      <div class="cc-h4row">
        <h4>Move history (${hist.length})</h4>
        <button data-act="download-history" title="Save as text">save</button>
      </div>
      <div class="cc-hist">${rows}</div>`;
    }
    renderAutopilot() {
      var _a, _b;
      const ap = (_b = (_a = this.hooks).getAutopilotView) == null ? void 0 : _b.call(_a);
      if (!ap) return "";
      return `
      <h4>Autopilot</h4>
      <p class="cc-note">
        <label><input type="checkbox" data-act="toggle-autopilot" ${ap.enabled ? "checked" : ""}/>
        <strong>Play my turns</strong></label>
        <span class="cc-muted"> — ${esc(ap.note)}</span>
      </p>`;
    }
    renderAfterGame() {
      var _a, _b, _c, _d;
      if (!((_b = (_a = this.hooks).getAutopilotView) == null ? void 0 : _b.call(_a))) return "";
      const captured = ((_d = (_c = this.hooks).captureCount) == null ? void 0 : _d.call(_c)) ?? 0;
      return `
      <p class="cc-note cc-muted">Plays your turn through colonist's own protocol: rolls, builds
      settlements, roads and cities (setup and mid-game), buys dev cards, bank-trades toward builds,
      plays knights and monopolies, moves the robber and steals, discards on a 7, ends the turn.
      Year-of-plenty / road-building dev cards still fall back to advice. Use in bot matches or games
      where everyone consents — automation can get accounts banned on ranked play.</p>
      ${this.renderRecord()}
      ${this.renderGameLogs()}
      ${captured > 0 ? `<p class="cc-note cc-muted">${captured} protocol frames captured — <button data-act="download-capture" style="font-size:11px;padding:1px 7px">download</button> for debugging.</p>` : ""}`;
    }
    renderRush() {
      var _a, _b;
      const rv = (_b = (_a = this.hooks).getRushView) == null ? void 0 : _b.call(_a);
      if (!rv) return "";
      const opt = (v, label) => `<option value="${v}" ${rv.pref === v ? "selected" : ""}>${label}</option>`;
      const detected = rv.modeSetting === null ? "mode unknown" : `game modeSetting = ${rv.modeSetting}`;
      return `
      <p class="cc-note">
        <strong>Rush mode</strong>
        <select data-act="rush-pref" style="font-size:11px">
          ${opt("auto", "auto-detect")}${opt("on", "on")}${opt("off", "off")}
        </select>
        <span class="cc-muted"> — ${rv.active ? `ACTIVE: ${esc(rv.note)}` : "inactive"} (${detected})</span>
      </p>
      ${rv.active ? `<p class="cc-note cc-muted">Rush has no turns: the pilot places setup settlements, builds roads / settlements / cities the moment they're affordable, moves the robber and discards on a 7. No rolling, trading or dev cards.</p>` : ""}`;
    }
    /** Win/loss record: stat tiles, a win-rate bar, recent form, and splits. */
    renderRecord() {
      const st = recordStats(loadRecords());
      if (!st) return "";
      const tile = (v, k, cls = "") => `<div class="cc-tile ${cls}"><div class="v">${v}</div><div class="k">${k}</div></div>`;
      const form = st.recent.map((w) => `<span class="dot ${w ? "win" : "loss"}" title="${w ? "win" : "loss"}"></span>`).join("");
      const streak = st.streak >= 2 ? `${st.streak} wins in a row` : st.streak <= -2 ? `${-st.streak} losses in a row` : "";
      const pct = (x) => `${Math.round(x * 100)}%`;
      const split = (label, rows) => rows.length < 1 ? "" : `<table class="cc-split"><tr><th>${label}</th><th>W–L</th><th style="width:42%">win rate</th></tr>${rows.map(
        (r) => `<tr><td>${esc(r.name)}</td><td>${r.wins}–${r.games - r.wins}</td>
              <td><div class="cc-rate"><span style="width:${pct(r.winRate)}"></span><em>${pct(r.winRate)}</em></div></td></tr>`
      ).join("")}</table>`;
      return `
      <div class="cc-record">
        <h4>Record <span class="cc-muted">(${st.games} game${st.games === 1 ? "" : "s"})</span></h4>
        <div class="cc-tiles">
          ${tile(pct(st.winRate), "win rate", "hero")}
          ${tile(String(st.wins), "wins", "win")}
          ${tile(String(st.losses), "losses", "loss")}
        </div>
        <div class="cc-ratebar" role="img" aria-label="win rate ${pct(st.winRate)}">
          <span style="width:${pct(st.winRate)}"></span>
        </div>
        <p class="cc-note"><span class="cc-muted">Last ${st.recent.length}:</span> <span class="cc-form">${form}</span>
          ${streak ? `<span class="cc-muted"> — ${streak}</span>` : ""}</p>
        ${split("Strategy", st.byStrategy)}
        ${st.byPlayers.length > 1 ? split("Table", st.byPlayers.map((r) => ({ ...r, name: `${r.players}-player` }))) : ""}
        <p class="cc-note cc-muted">Results feed back into strategy scores.</p>
      </div>`;
    }
    renderGameLogs() {
      var _a, _b;
      const n = ((_b = (_a = this.hooks).gameLogCount) == null ? void 0 : _b.call(_a)) ?? 0;
      if (n === 0) return "";
      return `<p class="cc-note cc-muted">${n} full game${n > 1 ? "s" : ""} logged for strategy analysis —
      <button data-act="download-gamelogs" style="font-size:11px;padding:1px 7px">download logs</button></p>`;
    }
    renderYourMove(actions) {
      if (actions.length === 0) return "";
      const items = actions.map(
        (a) => `<p class="cc-note${a.primary ? "" : " cc-muted"}">${a.primary ? "▶ " : ""}${esc(a.text)}</p>`
      ).join("");
      return `<div class="cc-card rec"><div class="t"><span>Your move</span></div>${items}</div>`;
    }
    /**
     * Chess-style position eval, recomputed on every render: win-probability
     * bar (us vs them) from visible VP, production, inferred opponent hand +
     * dev cards, and the top drivers as one-liners.
     */
    renderEval(state, bridge2) {
      var _a, _b;
      if (!state.youName || state.gameOver || state.rolls.length === 0) return "";
      const you = state.players.get(state.youName);
      const opponents = [...state.players.values()].filter((p) => p.name !== state.youName);
      if (!you || opponents.length === 0) return "";
      const planning = (_b = (_a = this.hooks).getPlanning) == null ? void 0 : _b.call(_a);
      if (planning) return `<h4>Remaining game (estimate)</h4><p class="cc-note">~${planning.horizon.turns.toFixed(1)} own turns before the first projected finish. Production investments are valued over that horizon.</p>`;
      const opp = opponents.reduce((a, b) => visibleVp(b) > visibleVp(a) ? b : a, opponents[0]);
      let gs = null;
      try {
        gs = (bridge2 == null ? void 0 : bridge2.toGameState()) ?? null;
      } catch {
        return "";
      }
      const board = (gs == null ? void 0 : gs.state.board) ?? null;
      const wp = estimateWinProbability(
        you,
        opp,
        state,
        board,
        (bridge2 == null ? void 0 : bridge2.robberHex) ?? null,
        (gs == null ? void 0 : gs.state.buildings) ?? null
      );
      const pct = Math.round(Math.min(0.95, Math.max(0.05, wp.probability)) * 100);
      const sign = wp.probability >= 0.5 ? "+" : "−";
      const ev = (Math.abs(wp.probability - 0.5) * 2).toFixed(1);
      const verdict = "Race estimate unavailable — showing observed position only";
      const drivers = [...wp.reasoning];
      const driverHtml = drivers.slice(0, 4).map((r) => `<li>${esc(r)}</li>`).join("");
      return `
      <h4>Eval ${sign}${ev} — ${verdict}</h4>
      <div class="cc-eval" title="Win probability estimate">
        <span class="cc-eval-you">${pct}%</span>
        <div class="cc-eval-bar"><div class="cc-eval-fill" style="width:${pct}%"></div></div>
        <span class="cc-eval-opp">${100 - pct}%</span>
      </div>
      ${driverHtml ? `<ul class="cc-note cc-muted cc-eval-why">${driverHtml}</ul>` : ""}`;
    }
    renderWhereToBuild(bridge2, gs, advice) {
      if (!bridge2 || !bridge2.board) {
        return `<h4>Where to build</h4><p class="cc-note cc-muted">Board not captured yet — refresh the page during the game so the copilot can read the board state.</p>`;
      }
      if (!gs || !advice) return "";
      const map = renderMiniMap(gs.state, {
        spots: advice.spots,
        roadEdges: advice.roadEdges,
        buildings: bridge2.buildings,
        roads: bridge2.roads
      });
      const circled = ["①", "②", "③"];
      const list = advice.spots.map((s) => `<p class="cc-note">${circled[s.rank - 1] ?? s.rank} ${esc(s.label)}</p>`).join("");
      return `
      <h4>${esc(advice.heading)}</h4>
      ${map}
      ${list}
      ${advice.note ? `<p class="cc-note cc-muted">${esc(advice.note)}</p>` : ""}`;
    }
    renderDeck(deck, state) {
      const cols = [];
      const maxCards = 6;
      for (let n = 2; n <= 12; n++) {
        const left = deck.remaining.get(n) ?? 0;
        const h = Math.round(left / maxCards * 34);
        const due = deck.due.includes(n);
        cols.push(`
        <div class="col">
          <div class="c">${left}</div>
          <div class="bar${left === 0 ? " cold" : ""}" style="height:${Math.max(2, h)}px"></div>
          <div class="n${due ? " due" : ""}">${n}</div>
        </div>`);
      }
      const yourNumbers = [];
      if (state.youName) {
        const you = state.players.get(state.youName);
        if (you) yourNumbers.push(...[...you.incomeByNumber.keys()].sort((a, b) => a - b));
      }
      let hitLine = "";
      if (yourNumbers.length > 0) {
        const pHit = yourNumbers.reduce((s, n) => s + (deck.prob.get(n) ?? 0), 0);
        hitLine = `<p class="cc-note">Your numbers (${yourNumbers.join(", ")}) hit the next roll with <strong>${Math.round(pHit * 100)}%</strong>.</p>`;
      }
      const dueLine = deck.due.length ? `<p class="cc-note">Over-due: <strong>${deck.due.join(", ")}</strong>. Exhausted: ${deck.cold.length ? deck.cold.join(", ") : "none"}.</p>` : "";
      return `
      <h4>Balanced-dice deck <span class="cc-muted">(${36 - deck.rollsIntoDeck} cards left, count above each bar)</span></h4>
      <div class="cc-deck">${cols.join("")}</div>
      ${hitLine}${dueLine}`;
    }
    /** Completion forecast; the heuristic is not a calibrated win probability. */
    renderWinChances() {
      var _a, _b;
      const plans = ((_b = (_a = this.hooks).getWinChances) == null ? void 0 : _b.call(_a)) ?? [];
      if (plans.length === 0) return "";
      const target = plans[0].target;
      const rows = plans.map((p) => {
        const cls = p.eliminated ? "out" : p.isYou ? "you" : "";
        const bar = p.eliminated || !Number.isFinite(p.turnsToWin) ? `<span class="cc-muted">No verified route</span>` : `<strong>~${p.turnsToWin.toFixed(1)} own turns</strong>`;
        const needBits = RESOURCES.filter((r) => (p.need[r] ?? 0) > 0).map((r) => `${p.need[r]} ${r}`);
        const need = needBits.length ? ` <span class="cc-muted">· need ${esc(needBits.join(", "))}</span>` : "";
        const tag = p.largestArmyReachable ? "" : "";
        return `
          <tr class="${cls}">
            <td class="cc-wname">${esc(p.name)}${p.isYou ? " <span class='cc-muted'>(you)</span>" : ""}
              <span class="cc-muted">${p.publicVp}/${target}</span></td>
            <td style="width:40%">${bar}</td>
          </tr>
          <tr class="${cls}"><td colspan="2" class="cc-wpath cc-muted">${esc(p.summary)}${need}${tag}</td></tr>`;
      }).join("");
      return `
      <h4>Race forecast <span class="cc-muted">(expected production)</span></h4>
      <p class="cc-note">Planning estimate, not win odds. Dice variation, hidden cards and incomplete hand tracking can change the race.</p>
      <table class="cc-wtable">${rows}</table>`;
    }
    renderPlayers(state) {
      var _a, _b, _c, _d;
      if (state.players.size === 0) return "";
      const rows = [...state.players.values()].sort((a, b) => visibleVp(b) - visibleVp(a)).map((p) => {
        const prodPips = Math.round(productionTotal(expectedProduction(p)) * 36);
        const total2 = p.serverCards ?? handTotal(p);
        const cards = p.serverCards === null ? `${total2}${p.uncertainty ? `±${p.uncertainty}` : ""}` : `${total2}${p.uncertainty ? ` <span class="cc-muted">(${p.uncertainty}?)</span>` : ""}`;
        const hand = HAND_ORDER.map(
          (r) => `<span class="cc-slot${p.hand[r] === 0 ? " zero" : ""}" title="${r}: ${p.hand[r]}" aria-label="${r} ${p.hand[r]}">${RESOURCE_ICON[r]}<span>${p.hand[r]}</span></span>`
        ).join("");
        return `
          <tr>
            <td><span class="dot" style="background:${esc(p.color)}"></span>${esc(p.name)}${state.youName === p.name ? " <span class='cc-muted'>(you)</span>" : ""}</td>
            <td>${visibleVp(p)}</td>
            <td title="${esc(p.trackingReason ?? p.trackingHealth ?? "unverified hand")}">${cards}${p.name !== state.youName ? ` <small>${esc(p.trackingHealth ?? "unverified")}</small>` : ""}</td>
            <td>${prodPips}</td>
            <td>${p.devCards}/${p.knightsPlayed}</td>
          </tr>
          <tr><td colspan="5" style="text-align:left;padding-left:18px"><div class="cc-hand">${hand}</div></td></tr>`;
      });
      const target = (_d = (_c = (_b = (_a = this.hooks).getPlanning) == null ? void 0 : _b.call(_a)) == null ? void 0 : _c.victories[0]) == null ? void 0 : _d.target;
      const mode = isOneVsOne(state) ? ` <span class="cc-muted">(1v1${target ? ` — first to ${target} VP` : ""})</span>` : "";
      return `
      <h4>Players${mode}</h4>
      <table>
        <tr><th>Player</th><th>VP</th><th>Cards</th><th>Pips</th><th>Dev/Kn</th></tr>
        ${rows.join("")}
      </table>`;
    }
    renderStrategies(fits) {
      if (fits.length === 0) return "";
      const cards = fits.slice(0, 3).map((f, i) => {
        const rec = i === 0;
        return `
        <div class="cc-card${rec ? " rec" : ""}">
          <div class="t"><span>${esc(f.strategy.name)}</span>${rec ? '<span class="cc-badge">RECOMMENDED</span>' : `<span class="cc-muted">~${f.simVp.toFixed(1)} VP</span>`}</div>
          <div class="tag">${esc(f.strategy.tagline)}</div>
          ${rec ? `<div class="cc-muted">Simulated ~${f.simVp.toFixed(1)} VP added over the next 25 turns (balanced dice, 30 trials)</div>` : ""}
          ${f.rationale.length ? `<ul>${f.rationale.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
        </div>`;
      });
      return `<h4>Your strategy</h4>${cards.join("")}`;
    }
    renderTrades(tips, oneVsOne) {
      const heading = oneVsOne ? "Bank & ports (no player trades in 1v1)" : "Trading";
      return `<h4>${heading}</h4>${tips.map((t) => `<p class="cc-note">${esc(t.text)}</p>`).join("")}`;
    }
  }
  const STATE_EVENT = { GAME_META: 1, INIT: 4, DIFF: 91 };
  const TILE_TYPE = {
    0: "desert",
    1: "wood",
    2: "brick",
    3: "sheep",
    4: "wheat",
    5: "ore"
  };
  const CARD_ID = {
    1: "wood",
    2: "brick",
    3: "sheep",
    4: "wheat",
    5: "ore"
  };
  const PORT_TYPE = {
    1: "any",
    2: "wood",
    3: "brick",
    4: "sheep",
    5: "wheat",
    6: "ore"
  };
  const TURN_ROLL = 1;
  const TURN_MAIN = 2;
  function deepMerge(target, src) {
    for (const key of Object.keys(src)) {
      const v = src[key];
      const cur = target[key];
      if (v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)) {
        deepMerge(cur, v);
      } else {
        target[key] = v;
      }
    }
  }
  class StateBridge {
    constructor() {
      __publicField(this, "state", {});
      __publicField(this, "myColor", null);
      __publicField(this, "colorToName", /* @__PURE__ */ new Map());
      __publicField(this, "colorIsBot", /* @__PURE__ */ new Map());
      __publicField(this, "board", null);
      __publicField(this, "robberHex", null);
      /** colonist send-channel id (serverId), needed to build outbound frames */
      __publicField(this, "serverId", null);
      /** friendly robber: can't rob a player with < 3 public VP */
      __publicField(this, "friendlyRobber", false);
      /** colonist gameSettings.modeSetting (0 = normal turns; Rush uses another value) */
      __publicField(this, "modeSetting", null);
      __publicField(this, "winTargetValue", null);
      __publicField(this, "boardTilesKey", "");
      /** engine vertex id -> colonist corner index, and edge id -> edge index */
      __publicField(this, "vertexToCorner", /* @__PURE__ */ new Map());
      __publicField(this, "edgeToIndex", /* @__PURE__ */ new Map());
    }
    reset() {
      this.state = {};
      this.myColor = null;
      this.colorToName.clear();
      this.colorIsBot.clear();
      this.board = null;
      this.robberHex = null;
      this.friendlyRobber = false;
      this.modeSetting = null;
      this.winTargetValue = null;
      this.boardTilesKey = "";
      this.vertexToCorner.clear();
      this.edgeToIndex.clear();
    }
    /** Feed a decoded frame. Returns true if it advanced game state. */
    apply(type, payload) {
      var _a, _b, _c, _d, _e;
      if (type === STATE_EVENT.GAME_META) {
        const id = payload == null ? void 0 : payload.serverId;
        if (id) this.serverId = id;
        return false;
      }
      if (type === STATE_EVENT.INIT) {
        const p = payload;
        this.reset();
        if (typeof (p == null ? void 0 : p.playerColor) === "number") this.myColor = p.playerColor;
        this.friendlyRobber = ((_a = p == null ? void 0 : p.gameSettings) == null ? void 0 : _a.friendlyRobber) === true;
        this.modeSetting = typeof ((_b = p == null ? void 0 : p.gameSettings) == null ? void 0 : _b.modeSetting) === "number" ? p.gameSettings.modeSetting : null;
        if (typeof ((_c = p == null ? void 0 : p.gameSettings) == null ? void 0 : _c.victoryPointsToWin) === "number")
          this.winTargetValue = p.gameSettings.victoryPointsToWin;
        for (const u of (p == null ? void 0 : p.playerUserStates) ?? []) {
          if ((u == null ? void 0 : u.username) && typeof u.selectedColor === "number") {
            this.colorToName.set(u.selectedColor, u.username);
            this.colorIsBot.set(u.selectedColor, !!u.isBot);
          }
        }
        this.state = (p == null ? void 0 : p.gameState) ?? {};
        this.rebuildBoard();
        this.syncRobber();
        return true;
      }
      if (type === STATE_EVENT.DIFF) {
        const diff = payload == null ? void 0 : payload.diff;
        if (!diff) return false;
        deepMerge(this.state, diff);
        if ((_d = diff.mapState) == null ? void 0 : _d.tileHexStates) this.rebuildBoard();
        if (diff.mechanicRobberState || ((_e = diff.mapState) == null ? void 0 : _e.tileHexStates)) this.syncRobber();
        return true;
      }
      return false;
    }
    // ---------------------------------------------------------------- turn/roll
    get currentTurnColor() {
      var _a;
      return ((_a = this.state.currentState) == null ? void 0 : _a.currentTurnPlayerColor) ?? null;
    }
    get turnState() {
      var _a;
      return ((_a = this.state.currentState) == null ? void 0 : _a.turnState) ?? null;
    }
    get diceThrown() {
      var _a;
      return ((_a = this.state.diceState) == null ? void 0 : _a.diceThrown) === true;
    }
    /** dev cards left in the bank, or null if the state hasn't shown them yet */
    get bankDevCards() {
      var _a, _b;
      const cards = (_b = (_a = this.state.mechanicDevelopmentCardsState) == null ? void 0 : _a.bankDevelopmentCards) == null ? void 0 : _b.cards;
      return Array.isArray(cards) ? cards.length : null;
    }
    /** Wire sources verified against the September 14 protocol capture:
     * 0 settlements, 1 cities, 2 private VP cards, 3 army, 4 longest road.
     * Held VP cards are counted separately from public points. */
    holdsLongestRoad(color) {
      var _a, _b, _c, _d, _e;
      return ((_b = (_a = this.state.mechanicLongestRoadState) == null ? void 0 : _a[String(color)]) == null ? void 0 : _b.hasLongestRoad) ?? (((_e = (_d = (_c = this.state.playerStates) == null ? void 0 : _c[String(color)]) == null ? void 0 : _d.victoryPointsState) == null ? void 0 : _e["4"]) ?? 0) > 0;
    }
    publicVp(color) {
      var _a, _b;
      const vp = (_b = (_a = this.state.playerStates) == null ? void 0 : _a[String(color)]) == null ? void 0 : _b.victoryPointsState;
      if (!vp) return 0;
      let total2 = 0;
      for (const [k, n] of Object.entries(vp)) {
        const v = n ?? 0;
        if (k === "1") total2 += v * 2;
        else if (k === "4" || k === "3") total2 += v > 0 ? 2 : 0;
        else if (k === "0") total2 += v;
      }
      return total2;
    }
    /** our own dev-card type ids (playable ones we hold), e.g. 13 = monopoly */
    myDevCardIds() {
      var _a, _b, _c, _d;
      if (this.myColor === null) return [];
      const cards = (_d = (_c = (_b = (_a = this.state.mechanicDevelopmentCardsState) == null ? void 0 : _a.players) == null ? void 0 : _b[String(this.myColor)]) == null ? void 0 : _c.developmentCards) == null ? void 0 : _d.cards;
      return Array.isArray(cards) ? cards.slice() : [];
    }
    /** Building pieces still in a player's supply (null = state not seen yet). */
    piecesLeft(color) {
      var _a, _b, _c, _d, _e, _f;
      const key = String(color);
      return {
        settlements: ((_b = (_a = this.state.mechanicSettlementState) == null ? void 0 : _a[key]) == null ? void 0 : _b.bankSettlementAmount) ?? null,
        cities: ((_d = (_c = this.state.mechanicCityState) == null ? void 0 : _c[key]) == null ? void 0 : _d.bankCityAmount) ?? null,
        roads: ((_f = (_e = this.state.mechanicRoadState) == null ? void 0 : _e[key]) == null ? void 0 : _f.bankRoadAmount) ?? null
      };
    }
    get isMyTurn() {
      return this.myColor !== null && this.currentTurnColor === this.myColor;
    }
    /** My turn, in the roll phase, dice not yet thrown → I must roll now. */
    get needsRoll() {
      return this.isMyTurn && this.turnState === TURN_ROLL && !this.diceThrown;
    }
    /** My turn, past the roll (build/trade phase). */
    get inMainPhase() {
      return this.isMyTurn && (this.turnState === TURN_MAIN || this.diceThrown);
    }
    // ---------------------------------------------------------------- board
    rebuildBoard() {
      var _a, _b, _c, _d;
      const tiles = (_a = this.state.mapState) == null ? void 0 : _a.tileHexStates;
      if (!tiles) return;
      const key = Object.values(tiles).map((t) => `${t.x},${t.y},${t.type},${t.diceNumber}`).join("|");
      if (key === this.boardTilesKey && this.board) return;
      this.boardTilesKey = key;
      this.board = buildBoard(
        0,
        Object.values(tiles).map((t) => {
          const kind = TILE_TYPE[t.type] ?? "desert";
          return { q: t.x, r: t.y, kind, token: kind === "desert" || !t.diceNumber ? null : t.diceNumber };
        })
      );
      for (const pe of Object.values(((_b = this.state.mapState) == null ? void 0 : _b.portEdgeStates) ?? {})) {
        const kind = PORT_TYPE[pe.type] ?? "any";
        const port = { kind, ratio: kind === "any" ? 3 : 2 };
        for (const pt of colonistEdgeToPixels(pe)) {
          const v = findVertexAt(this.board, pt.x, pt.y);
          if (v) v.port = { ...port };
        }
      }
      this.vertexToCorner.clear();
      this.edgeToIndex.clear();
      for (const [idx, c] of Object.entries(((_c = this.state.mapState) == null ? void 0 : _c.tileCornerStates) ?? {})) {
        const pt = colonistCornerToPixel(c);
        const v = findVertexAt(this.board, pt.x, pt.y);
        if (v) this.vertexToCorner.set(v.id, Number(idx));
      }
      for (const [idx, e] of Object.entries(((_d = this.state.mapState) == null ? void 0 : _d.tileEdgeStates) ?? {})) {
        const [p1, p2] = colonistEdgeToPixels(e);
        const va = findVertexAt(this.board, p1.x, p1.y);
        const vb = findVertexAt(this.board, p2.x, p2.y);
        if (!va || !vb) continue;
        const edge = findEdgeBetween(this.board, va.id, vb.id);
        if (edge) this.edgeToIndex.set(edge.id, Number(idx));
      }
    }
    /** colonist corner index for an engine vertex (settlement/city payload). */
    cornerIndexForVertex(vertexId) {
      return this.vertexToCorner.get(vertexId) ?? null;
    }
    /** colonist edge index for an engine edge (road payload). */
    edgeIndexForEdge(edgeId) {
      return this.edgeToIndex.get(edgeId) ?? null;
    }
    /** colonist tile (hex) index at axial q,r (robber payload). */
    tileIndexForHex(q, r) {
      var _a;
      for (const [idx, t] of Object.entries(((_a = this.state.mapState) == null ? void 0 : _a.tileHexStates) ?? {})) {
        if (t.x === q && t.y === r) return Number(idx);
      }
      return null;
    }
    /** corner index whose stored {x,y,z} equals the given colonist coord. */
    cornerIndexForCoord(c) {
      var _a;
      for (const [idx, s] of Object.entries(((_a = this.state.mapState) == null ? void 0 : _a.tileCornerStates) ?? {})) {
        if (s.x === c.x && s.y === c.y && s.z === (c.z ?? s.z)) return Number(idx);
      }
      return null;
    }
    /** edge index whose stored {x,y,z} equals the given colonist coord. */
    edgeIndexForCoord(c) {
      var _a;
      for (const [idx, s] of Object.entries(((_a = this.state.mapState) == null ? void 0 : _a.tileEdgeStates) ?? {})) {
        if (s.x === c.x && s.y === c.y && s.z === (c.z ?? s.z)) return Number(idx);
      }
      return null;
    }
    /** Opponent colors with a building on the given tile index, richest first. */
    opponentsOnTile(tileIndex) {
      var _a, _b;
      if (!this.board) return [];
      const tile = (_b = (_a = this.state.mapState) == null ? void 0 : _a.tileHexStates) == null ? void 0 : _b[String(tileIndex)];
      if (!tile) return [];
      const hex = this.board.hexes.find((h) => h.q === tile.x && h.r === tile.y);
      if (!hex) return [];
      return this.buildings.filter(
        (b) => b.colorId !== this.myColor && this.board.vertices[b.vertexId].hexIds.includes(hex.id)
      ).sort((a, b) => this.handOf(b.colorId).total - this.handOf(a.colorId).total).map((b) => b.colorId);
    }
    syncRobber() {
      var _a, _b;
      const idx = (_a = this.state.mechanicRobberState) == null ? void 0 : _a.locationTileIndex;
      const tiles = (_b = this.state.mapState) == null ? void 0 : _b.tileHexStates;
      if (idx === void 0 || !tiles) return;
      const tile = tiles[String(idx)];
      if (tile) this.robberHex = { x: tile.x, y: tile.y };
    }
    get buildings() {
      var _a;
      if (!this.board) return [];
      const out = [];
      for (const c of Object.values(((_a = this.state.mapState) == null ? void 0 : _a.tileCornerStates) ?? {})) {
        if (c.owner === void 0 || c.buildingType === void 0) continue;
        const pt = colonistCornerToPixel(c);
        const v = findVertexAt(this.board, pt.x, pt.y);
        if (v) out.push({ vertexId: v.id, colorId: c.owner, kind: c.buildingType === 2 ? "city" : "settlement" });
      }
      return out;
    }
    get roads() {
      var _a;
      if (!this.board) return [];
      const out = [];
      for (const e of Object.values(((_a = this.state.mapState) == null ? void 0 : _a.tileEdgeStates) ?? {})) {
        if (e.owner === void 0) continue;
        const [p1, p2] = colonistEdgeToPixels(e);
        const va = findVertexAt(this.board, p1.x, p1.y);
        const vb = findVertexAt(this.board, p2.x, p2.y);
        if (!va || !vb) continue;
        const edge = findEdgeBetween(this.board, va.id, vb.id);
        if (edge) out.push({ edgeId: edge.id, colorId: e.owner });
      }
      return out;
    }
    // ---------------------------------------------------------------- hands
    /** Exact resource counts for a color; opponents' cards are masked (id 0). */
    handOf(color) {
      var _a, _b, _c;
      const cards = ((_c = (_b = (_a = this.state.playerStates) == null ? void 0 : _a[String(color)]) == null ? void 0 : _b.resourceCards) == null ? void 0 : _c.cards) ?? [];
      const known = {};
      for (const id of cards) {
        const r = CARD_ID[id];
        if (r) known[r] = (known[r] ?? 0) + 1;
      }
      return { total: cards.length, known };
    }
    /**
     * Player-trade offers awaiting OUR answer: offers from other players we
     * haven't responded to yet (playerResponses[me] 0/absent). Closed offers
     * arrive as null and are skipped. Responses: 1 = accepted, 2 = declined.
     */
    pendingTradeOffers() {
      var _a, _b;
      if (this.myColor === null) return [];
      const out = [];
      const count = (ids) => {
        const m = {};
        for (const id of ids ?? []) {
          const r = CARD_ID[id];
          if (r) m[r] = (m[r] ?? 0) + 1;
        }
        return m;
      };
      for (const [id, o] of Object.entries(((_a = this.state.tradeState) == null ? void 0 : _a.activeOffers) ?? {})) {
        if (!o || typeof o.creator !== "number" || o.creator === this.myColor) continue;
        if ((((_b = o.playerResponses) == null ? void 0 : _b[String(this.myColor)]) ?? 0) !== 0) continue;
        out.push({ id, creator: o.creator, offered: count(o.offeredResources), wanted: count(o.wantedResources) });
      }
      return out;
    }
    /** a player's longest continuous road (segments), 0 if unseen. */
    longestRoad(color) {
      var _a, _b;
      return ((_b = (_a = this.state.mechanicLongestRoadState) == null ? void 0 : _a[String(color)]) == null ? void 0 : _b.longestRoad) ?? 0;
    }
    /** victory points needed to win (colonist default 10; some modes 15). */
    get winTarget() {
      return this.winTargetValue ?? 10;
    }
    /** Our own active trade offer (id + who has accepted), or null. */
    myOpenOffer() {
      var _a;
      if (this.myColor === null) return null;
      for (const [id, o] of Object.entries(((_a = this.state.tradeState) == null ? void 0 : _a.activeOffers) ?? {})) {
        if (!o || o.creator !== this.myColor) continue;
        const acceptedBy = Object.entries(o.playerResponses ?? {}).filter(([, v]) => v === 1).map(([c]) => Number(c));
        return { id, acceptedBy };
      }
      return null;
    }
    discardLimit(color) {
      var _a, _b;
      return ((_b = (_a = this.state.playerStates) == null ? void 0 : _a[String(color)]) == null ? void 0 : _b.cardDiscardLimit) ?? null;
    }
    bankRatios(color) {
      var _a, _b;
      const raw = ((_b = (_a = this.state.playerStates) == null ? void 0 : _a[String(color)]) == null ? void 0 : _b.bankTradeRatiosState) ?? {};
      const out = {};
      for (const [id, ratio] of Object.entries(raw)) {
        const r = CARD_ID[Number(id)];
        if (r) out[r] = ratio;
      }
      return out;
    }
    // ---------------------------------------------------------------- engine view
    colorOrder() {
      return [...this.colorToName.keys()].sort((a, b) => a - b);
    }
    toGameState() {
      if (!this.board) return null;
      const order = this.colorOrder();
      const toPid = (c) => Math.min(3, Math.max(0, order.indexOf(c)));
      const state = {
        board: this.board,
        buildings: this.buildings.map((b) => ({ vertexId: b.vertexId, player: toPid(b.colorId), kind: b.kind })),
        roads: this.roads.map((r) => ({ edgeId: r.edgeId, player: toPid(r.colorId) }))
      };
      const youPlayer = this.myColor !== null && order.includes(this.myColor) ? toPid(this.myColor) : null;
      return { state, youPlayer };
    }
  }
  const ACTION_KINDS = [
    "build-settlement",
    "build-road",
    "build-city",
    "buy-dev",
    "roll",
    "end-turn",
    "move-robber",
    "discard",
    "play-knight",
    "play-monopoly",
    "play-road-building",
    "play-year-of-plenty",
    "bank-trade",
    "trade-response",
    "propose-trade"
  ];
  const HEXFACE_ACTIONS = /* @__PURE__ */ new Set(["move-robber"]);
  const CARDS_ACTIONS = /* @__PURE__ */ new Set(["discard"]);
  const COORD_ACTIONS = /* @__PURE__ */ new Set([
    "build-settlement",
    "build-road",
    "build-city",
    "move-robber"
  ]);
  const STORAGE_KEY = "catanCopilot:protocol";
  const PAIR_WINDOW_MS = 5e3;
  function isCoordObject(v, hexFace) {
    if (typeof v !== "object" || v === null) return false;
    const o = v;
    if (!Number.isInteger(o.x) || !Number.isInteger(o.y)) return false;
    if (hexFace) {
      return o.z === void 0 && Object.keys(v).length <= 3;
    }
    return Number.isInteger(o.z) && Object.keys(v).length <= 4;
  }
  function findCoordPath(frame, hexFace, path = []) {
    if (isCoordObject(frame, hexFace)) return path;
    if (Array.isArray(frame)) {
      for (let i = 0; i < frame.length; i++) {
        const found = findCoordPath(frame[i], hexFace, [...path, String(i)]);
        if (found) return found;
      }
    } else if (typeof frame === "object" && frame !== null) {
      for (const [k, v] of Object.entries(frame)) {
        const found = findCoordPath(v, hexFace, [...path, k]);
        if (found) return found;
      }
    }
    return null;
  }
  function isCardIdArray(v) {
    return Array.isArray(v) && v.length > 0 && v.every((x) => Number.isInteger(x) && x >= 1 && x <= 5);
  }
  function findCardsPath(frame, path = []) {
    if (isCardIdArray(frame)) return path;
    if (Array.isArray(frame)) {
      for (let i = 0; i < frame.length; i++) {
        const found = findCardsPath(frame[i], [...path, String(i)]);
        if (found) return found;
      }
    } else if (typeof frame === "object" && frame !== null) {
      for (const [k, v] of Object.entries(frame)) {
        const found = findCardsPath(v, [...path, k]);
        if (found) return found;
      }
    }
    return null;
  }
  function getAtPath(obj, path) {
    let cur = obj;
    for (const key of path) {
      if (cur === null || typeof cur !== "object") return void 0;
      cur = cur[key];
    }
    return cur;
  }
  class ProtocolLearner {
    constructor() {
      __publicField(this, "templates", {});
      __publicField(this, "outbox", []);
      /** stats for shallow integer fields, to find sequence counters */
      __publicField(this, "seqStats", /* @__PURE__ */ new Map());
    }
    recordOutbound(frame, t = Date.now()) {
      this.outbox.push({ t, frame, used: false });
      if (this.outbox.length > 200) this.outbox.shift();
      this.trackSeqFields(frame);
    }
    trackSeqFields(frame, prefix = [], depth = 0) {
      if (depth > 2 || typeof frame !== "object" || frame === null || Array.isArray(frame)) return;
      for (const [k, v] of Object.entries(frame)) {
        if (typeof v === "number" && Number.isInteger(v)) {
          const key = [...prefix, k].join(".");
          const stat = this.seqStats.get(key);
          if (!stat) {
            this.seqStats.set(key, { last: v, seen: 1, increasing: true });
          } else {
            stat.increasing = stat.increasing && v > stat.last;
            stat.last = v;
            stat.seen++;
          }
        } else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
          this.trackSeqFields(v, [...prefix, k], depth + 1);
        }
      }
    }
    /**
     * An action was confirmed (seen in the log / board events). Pair it with
     * the most recent unpaired outbound frame in the window; that frame is the
     * message that caused it. Later confirmations overwrite earlier templates,
     * so quality improves over a session.
     */
    confirm(kind, t = Date.now()) {
      for (let i = this.outbox.length - 1; i >= 0; i--) {
        const o = this.outbox[i];
        if (o.used || o.t > t || t - o.t > PAIR_WINDOW_MS) continue;
        o.used = true;
        const wantsCoord = COORD_ACTIONS.has(kind);
        const coordPath = wantsCoord ? findCoordPath(o.frame, HEXFACE_ACTIONS.has(kind)) : null;
        if (wantsCoord && !coordPath) continue;
        const wantsCards = CARDS_ACTIONS.has(kind);
        const cardsPath = wantsCards ? findCardsPath(o.frame) : null;
        if (wantsCards && !cardsPath) continue;
        this.templates[kind] = {
          frame: JSON.parse(JSON.stringify(o.frame)),
          coordPath,
          cardsPath,
          learnedAt: t
        };
        this.save();
        return;
      }
    }
    /** Produce a sendable frame for an action, or null if not learned yet. */
    buildFrame(kind, coord, cards) {
      const tpl = this.templates[kind];
      if (!tpl) return null;
      const frame = JSON.parse(JSON.stringify(tpl.frame));
      if (tpl.cardsPath) {
        if (!cards || cards.length === 0) return null;
        if (tpl.cardsPath.length === 0) return [...cards];
        const leaf = tpl.cardsPath[tpl.cardsPath.length - 1];
        const parent = getAtPath(frame, tpl.cardsPath.slice(0, -1));
        if (!parent || typeof parent !== "object") return null;
        parent[leaf] = [...cards];
      }
      if (tpl.coordPath) {
        if (!coord) return null;
        const target = getAtPath(frame, tpl.coordPath);
        if (!target) return null;
        target.x = coord.x;
        target.y = coord.y;
        if ("z" in target && coord.z !== void 0) target.z = coord.z;
      }
      for (const [key, stat] of this.seqStats) {
        if (!stat.increasing || stat.seen < 3) continue;
        const path = key.split(".");
        const parent = path.length === 1 ? frame : getAtPath(frame, path.slice(0, -1));
        const leaf = path[path.length - 1];
        if (parent && typeof parent === "object" && typeof parent[leaf] === "number") {
          parent[leaf] = stat.last + 1;
          stat.last = stat.last + 1;
        }
      }
      return frame;
    }
    /** Self-correction: a template that produced no confirmed effect is wrong. */
    discard(kind) {
      delete this.templates[kind];
      this.save();
    }
    status() {
      return Object.fromEntries(
        ACTION_KINDS.map((k) => [k, this.templates[k] !== void 0])
      );
    }
    learnedCount() {
      return ACTION_KINDS.filter((k) => this.templates[k]).length;
    }
    save() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.templates));
      } catch {
      }
    }
    load() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) this.templates = JSON.parse(raw);
      } catch {
      }
    }
  }
  const RUSH_ACTIONS = /* @__PURE__ */ new Set([
    "build-settlement",
    "build-road",
    "build-city",
    "move-robber",
    "discard"
  ]);
  function decideRush(opts) {
    const d = decideNext({
      tracker: opts.tracker,
      youName: opts.youName,
      fit: opts.fit,
      gs: opts.gs,
      advice: opts.advice,
      rolledThisTurn: true,
      // there is no roll in Rush — never wait for one
      robberPending: opts.robberPending,
      robberHex: opts.robberHex,
      discardPending: opts.discardPending,
      piecesLeft: opts.piecesLeft,
      canRob: opts.canRob,
      allow: RUSH_ACTIONS
    });
    return d && RUSH_ACTIONS.has(d.kind) ? d : null;
  }
  const PENDING_TIMEOUT_MS = 5e3;
  class RushPilot {
    constructor(dispatch) {
      __publicField(this, "enabled", false);
      __publicField(this, "robberPending", false);
      __publicField(this, "discardPending", false);
      __publicField(this, "pending", null);
      __publicField(this, "note", "off");
      this.dispatch = dispatch;
    }
    setEnabled(on) {
      this.enabled = on;
      this.note = on ? "on — Rush: building whenever affordable" : "off";
      if (!on) this.pending = null;
    }
    setRobberPending(pending) {
      this.robberPending = pending;
    }
    setDiscardPending(pending) {
      this.discardPending = pending;
    }
    onConfirm(kind) {
      var _a;
      if (((_a = this.pending) == null ? void 0 : _a.kind) === kind) this.pending = null;
      if (kind === "move-robber") this.robberPending = false;
      if (kind === "discard") this.discardPending = false;
    }
    view() {
      return { enabled: this.enabled, note: this.note };
    }
    tick(ctx) {
      if (!this.enabled) return;
      const now = ctx.now ?? Date.now();
      if (this.pending) {
        if (now - this.pending.t <= PENDING_TIMEOUT_MS) return;
        this.note = `"${this.pending.kind}" wasn't confirmed — retrying`;
        this.pending = null;
      }
      const youName = ctx.tracker.youName;
      if (!youName) return;
      const you = ctx.tracker.players.get(youName);
      const mustDiscard = this.discardPending && !!you && handTotal(you) > ctx.tracker.discardLimit;
      const decision = decideRush({
        ...ctx,
        youName,
        robberPending: this.robberPending,
        discardPending: mustDiscard
      });
      if (!decision) {
        this.note = this.robberPending ? "on — move the robber manually (no good tile found)" : "on — Rush: waiting for resources";
        return;
      }
      if (this.dispatch(decision)) {
        this.pending = { kind: decision.kind, t: now };
        this.note = `acting: ${decision.describe}`;
      } else {
        this.note = `▶ Your click: ${decision.describe} (couldn't send it)`;
      }
    }
  }
  const RUSH_MODE_SETTINGS = /* @__PURE__ */ new Set([12]);
  const PREF_KEY = "catanCopilot:rushMode";
  function loadRushPref() {
    try {
      const v = localStorage.getItem(PREF_KEY);
      return v === "on" || v === "off" ? v : "auto";
    } catch {
      return "auto";
    }
  }
  function saveRushPref(pref) {
    try {
      localStorage.setItem(PREF_KEY, pref);
    } catch {
    }
  }
  function isRushMode(modeSetting, pref) {
    if (pref === "on") return true;
    if (pref === "off") return false;
    return modeSetting !== null && RUSH_MODE_SETTINGS.has(modeSetting);
  }
  const KEY = "catanCopilot:gamelogs";
  const MAX_LOGS = 40;
  function loadGameLogs() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }
  function saveGameLog(log) {
    try {
      const all = loadGameLogs();
      all.push(log);
      const retained = all.slice(-MAX_LOGS);
      while (retained.length) {
        try {
          localStorage.setItem(KEY, JSON.stringify(retained));
          break;
        } catch {
          if (retained.length === 1) throw new Error("Game log exceeds storage quota");
          retained.shift();
        }
      }
    } catch {
    }
  }
  const ACTION = {
    ROLL: 2,
    // payload: true
    MOVE_ROBBER: 3,
    // payload: tile (hex) index
    STEAL: 5,
    // payload: victim color id
    END_TURN: 6,
    // payload: true
    DISCARD_CONFIRM: 7,
    // payload: full array of card ids to discard
    DISCARD_SELECT: 8,
    // payload: cumulative selection array (one card added each time)
    BUY_DEV: 9,
    // payload: true — buy a development card
    // Each build is [intent, place] as consecutive codes: road 10/11,
    // settlement 14/15, city 17/18. Settlement and city intents are confirmed
    // from captures; ROAD_INTENT (10) is inferred from that pattern (no normal
    // paid road appears in any capture yet) — it fails safe if wrong.
    BUILD_ROAD_INTENT: 10,
    // payload: true — enter build-road mode (main game, INFERRED)
    BUILD_ROAD: 11,
    // payload: edge index
    BUILD_SETTLEMENT_INTENT: 14,
    // payload: true — enter build-settlement mode (main game)
    BUILD_SETTLEMENT: 15,
    // payload: corner index
    BUILD_CITY_INTENT: 17,
    // payload: true — enter build-city mode (main game)
    BUILD_CITY: 18,
    // payload: corner index of the settlement to upgrade
    PLAY_DEV: 48,
    // payload: dev-card type id (e.g. 13 = monopoly, 11 = road building)
    CREATE_TRADE: 49,
    // payload: { creator, isBankTrade, offeredResources[], wantedResources[] }
    // Answer a player-trade offer (captured 2026-08-22 from a live accept click):
    // payload { id, response } where response 0 = ACCEPT (the inbound state then
    // shows playerResponses[me] = 1). Decline is response 1 (state shows 2).
    TRADE_RESPONSE: 50,
    PRESELECT: 66
    // payload: corner/edge index (UI hover) or null to clear
  };
  const DEV_CARD = {
    KNIGHT: 11,
    MONOPOLY: 13,
    ROAD_BUILDING: 14,
    YEAR_OF_PLENTY: 15
  };
  function rollAction() {
    return [{ action: ACTION.ROLL, payload: true }];
  }
  function endTurnAction() {
    return [{ action: ACTION.END_TURN, payload: true }];
  }
  function buyDevAction() {
    return [{ action: ACTION.BUY_DEV, payload: true }];
  }
  function settlementActions(cornerIndex) {
    return [
      { action: ACTION.PRESELECT, payload: cornerIndex },
      { action: ACTION.PRESELECT, payload: null },
      { action: ACTION.BUILD_SETTLEMENT, payload: cornerIndex }
    ];
  }
  function buildSettlementActions(cornerIndex) {
    return [
      { action: ACTION.BUILD_SETTLEMENT_INTENT, payload: true },
      { action: ACTION.BUILD_SETTLEMENT, payload: cornerIndex }
    ];
  }
  function roadActions(edgeIndex) {
    return [
      { action: ACTION.PRESELECT, payload: edgeIndex },
      { action: ACTION.PRESELECT, payload: null },
      { action: ACTION.BUILD_ROAD, payload: edgeIndex }
    ];
  }
  function buildRoadActions(edgeIndex) {
    return [
      { action: ACTION.BUILD_ROAD_INTENT, payload: true },
      { action: ACTION.BUILD_ROAD, payload: edgeIndex }
    ];
  }
  function buildCityActions(cornerIndex) {
    return [
      { action: ACTION.BUILD_CITY_INTENT, payload: true },
      { action: ACTION.BUILD_CITY, payload: cornerIndex }
    ];
  }
  function knightActions() {
    return [{ action: ACTION.PLAY_DEV, payload: DEV_CARD.KNIGHT }];
  }
  function roadBuildingActions() {
    return [{ action: ACTION.PLAY_DEV, payload: DEV_CARD.ROAD_BUILDING }];
  }
  function yearOfPlentyActions(resourceIds) {
    return [
      { action: ACTION.PLAY_DEV, payload: DEV_CARD.YEAR_OF_PLENTY },
      { action: ACTION.DISCARD_SELECT, payload: [resourceIds[0]] },
      { action: ACTION.DISCARD_SELECT, payload: [resourceIds[0], resourceIds[1]] },
      { action: ACTION.DISCARD_CONFIRM, payload: [resourceIds[0], resourceIds[1]] }
    ];
  }
  function monopolyActions(resourceId) {
    return [
      { action: ACTION.PLAY_DEV, payload: DEV_CARD.MONOPOLY },
      { action: ACTION.DISCARD_SELECT, payload: [resourceId] },
      { action: ACTION.DISCARD_CONFIRM, payload: [resourceId] }
    ];
  }
  function bankTradeActions(myColor, giveId, giveCount, getId) {
    return [
      {
        action: ACTION.CREATE_TRADE,
        payload: {
          creator: myColor,
          isBankTrade: true,
          counterOfferInResponseToTradeId: null,
          offeredResources: Array.from({ length: giveCount }, () => giveId),
          wantedResources: [getId]
        }
      }
    ];
  }
  function tradeResponseActions(tradeId, accept) {
    return [{ action: ACTION.TRADE_RESPONSE, payload: { id: tradeId, response: accept ? 0 : 1 } }];
  }
  function playerTradeActions(myColor, offeredIds, wantedIds) {
    if (offeredIds.length === 0 || wantedIds.length === 0) return [];
    return [
      {
        action: ACTION.CREATE_TRADE,
        payload: {
          creator: myColor,
          isBankTrade: false,
          counterOfferInResponseToTradeId: null,
          offeredResources: [...offeredIds],
          wantedResources: [...wantedIds]
        }
      }
    ];
  }
  function robberActions(tileIndex, victimColor) {
    const out = [{ action: ACTION.MOVE_ROBBER, payload: tileIndex }];
    if (victimColor !== null) out.push({ action: ACTION.STEAL, payload: victimColor });
    return out;
  }
  function discardActions(cardIds) {
    if (cardIds.length === 0) return [];
    const out = [];
    for (let i = 1; i <= cardIds.length; i++) {
      out.push({ action: ACTION.DISCARD_SELECT, payload: cardIds.slice(0, i) });
    }
    out.push({ action: ACTION.DISCARD_CONFIRM, payload: cardIds.slice() });
    return out;
  }
  const SEND_MARKER = "__catan_copilot_send__";
  function dispatchDecision(d, opts) {
    if (!bridge.serverId) return false;
    const mainGame = (opts == null ? void 0 : opts.setupPhase) !== void 0 ? !opts.setupPhase : bridge.turnState === 2;
    const send = (actions) => {
      if (actions.length === 0) return false;
      recordDecision(d);
      window.postMessage({ [SEND_MARKER]: true, actions }, "*");
      return true;
    };
    switch (d.kind) {
      case "roll":
        return send(rollAction());
      case "end-turn":
        return send(endTurnAction());
      case "buy-dev":
        return send(buyDevAction());
      case "build-settlement": {
        const idx = d.coord ? bridge.cornerIndexForCoord(d.coord) : null;
        if (idx === null) return false;
        return send(mainGame ? buildSettlementActions(idx) : settlementActions(idx));
      }
      case "build-road": {
        const idx = d.coord ? bridge.edgeIndexForCoord(d.coord) : null;
        if (idx === null) return false;
        return send(mainGame && !d.free ? buildRoadActions(idx) : roadActions(idx));
      }
      case "build-city": {
        const idx = d.coord ? bridge.cornerIndexForCoord(d.coord) : null;
        return idx !== null ? send(buildCityActions(idx)) : false;
      }
      case "move-robber": {
        if (!d.coord) return false;
        const tile = bridge.tileIndexForHex(d.coord.x, d.coord.y);
        if (tile === null) return false;
        const victim = bridge.opponentsOnTile(tile)[0] ?? null;
        return send(robberActions(tile, victim));
      }
      case "discard": {
        const ids = cardsToIds(d.cards ?? {});
        return ids.length > 0 ? send(discardActions(ids)) : false;
      }
      case "bank-trade": {
        if (!d.trade || bridge.myColor === null) return false;
        const giveId = RESOURCE_TO_CARD_ID[d.trade.give];
        const getId = RESOURCE_TO_CARD_ID[d.trade.get];
        return send(bankTradeActions(bridge.myColor, giveId, d.trade.giveCount, getId));
      }
      case "play-monopoly": {
        syncTrackerFromState();
        if (!d.resource || !(tracker == null ? void 0 : tracker.youName) || confirmedMonopolyHaul(tracker.players.values(), tracker.youName, d.resource) <= 0) return false;
        return send(monopolyActions(RESOURCE_TO_CARD_ID[d.resource]));
      }
      case "play-knight":
        return send(knightActions());
      case "play-road-building":
        return send(roadBuildingActions());
      case "trade-response":
        return d.tradeId ? send(tradeResponseActions(d.tradeId, !!d.accept)) : false;
      case "propose-trade": {
        if (!d.offer || bridge.myColor === null) return false;
        return send(playerTradeActions(bridge.myColor, cardsToIds(d.offer.offered), cardsToIds(d.offer.wanted)));
      }
      case "play-year-of-plenty": {
        if (!d.resources || d.resources.length !== 2) return false;
        return send(
          yearOfPlentyActions([
            RESOURCE_TO_CARD_ID[d.resources[0]],
            RESOURCE_TO_CARD_ID[d.resources[1]]
          ])
        );
      }
      default:
        return false;
    }
  }
  let tracker = null;
  let overlay = null;
  const bridge = new StateBridge();
  const learner = new ProtocolLearner();
  learner.load();
  const autopilot = new Autopilot(learner, dispatchDecision);
  const rushPilot = new RushPilot((d) => {
    const mine = bridge.myColor === null ? 0 : bridge.buildings.filter((b) => b.colorId === bridge.myColor).length;
    return dispatchDecision(d, { setupPhase: mine < 2 });
  });
  let rushPref = loadRushPref();
  function rushActive() {
    return isRushMode(bridge.modeSetting, rushPref);
  }
  function pilotConfirm(kind) {
    (rushActive() ? rushPilot : autopilot).onConfirm(kind);
    if (kind !== "play-monopoly") {
      const action = [...decisionHistory].reverse().find((d) => d.decision.kind === kind && !d.outcome);
      if (action) action.outcome = { confirmed: true, eventId: lastProcessedIndex };
    }
  }
  const AUTOPILOT_PREF = "catanCopilot:autopilotOn";
  function loadAutopilotPref() {
    try {
      const v = localStorage.getItem(AUTOPILOT_PREF);
      return v === null ? true : v === "1";
    } catch {
      return true;
    }
  }
  autopilot.setEnabled(loadAutopilotPref());
  rushPilot.setEnabled(loadAutopilotPref());
  let prevTurnColor = null;
  let prevMyBuildings = 0;
  let prevMyCities = 0;
  let prevMyRoads = 0;
  let gameRecorded = false;
  const capture = [];
  const CAPTURE_LIMIT = 5e3;
  function downloadCapture() {
    const blob = new Blob([JSON.stringify(capture, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `catan-copilot-capture-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  let observer = null;
  let lastProcessedIndex = -1;
  let renderTimer;
  const moveHistory = [];
  const HISTORY_LIMIT = 400;
  function fmtRes(res) {
    return RESOURCES.filter((r) => (res[r] ?? 0) > 0).map((r) => `${res[r]} ${r}`).join(" + ");
  }
  function fmtDelta(d) {
    const gave = RESOURCES.filter((r) => (d[r] ?? 0) < 0).map((r) => `${-(d[r] ?? 0)} ${r}`);
    const got = RESOURCES.filter((r) => (d[r] ?? 0) > 0).map((r) => `${d[r]} ${r}`);
    return [gave.length ? `gave ${gave.join(" + ")}` : "", got.length ? `got ${got.join(" + ")}` : ""].filter(Boolean).join(", ");
  }
  function describeMove(ev, you) {
    const meName = you ?? "you";
    switch (ev.type) {
      case "roll":
        return { player: ev.player, text: `rolled ${ev.total}` };
      case "place":
        return { player: ev.player, text: `placed a ${ev.what}` };
      case "build":
        return { player: ev.player, text: `built a ${ev.what}` };
      case "buy-dev":
        return { player: ev.player, text: "bought a development card" };
      case "bank-trade":
        return { player: ev.player, text: `bank-traded — ${fmtDelta(ev.delta)}` };
      case "player-trade":
        return {
          player: ev.player,
          text: `traded${ev.partner ? ` with ${ev.partner}` : ""} — ${fmtDelta(ev.delta)}`
        };
      case "steal-known":
        return { player: ev.thief ?? meName, text: `stole from ${ev.victim ?? meName}` };
      case "steal-unknown":
        return { player: ev.thief ?? meName, text: `stole from ${ev.victim ?? meName}` };
      case "monopoly-steal":
        return { player: ev.player, text: `monopoly — took ${ev.count} ${ev.resource}` };
      case "discard":
        return { player: ev.player, text: `discarded ${fmtRes(ev.resources)}` };
      case "use-knight":
        return { player: ev.player, text: "played a knight" };
      case "use-dev":
        return { player: ev.player, text: `played ${ev.card.replace(/-/g, " ")}` };
      case "move-robber":
        return { player: ev.player, text: "moved the robber" };
      case "game-over":
        return { player: ev.winner, text: "won the game 🏆" };
      default:
        return null;
    }
  }
  function recordMove(ev) {
    const m = describeMove(ev, (tracker == null ? void 0 : tracker.youName) ?? null);
    if (!m) return;
    moveHistory.push({
      t: Date.now(),
      player: m.player,
      text: m.text,
      mine: m.player !== null && m.player === (tracker == null ? void 0 : tracker.youName)
    });
    if (moveHistory.length > HISTORY_LIMIT) moveHistory.shift();
  }
  function downloadGameLogs() {
    const logs = loadGameLogs();
    const blob = new Blob([JSON.stringify(logs, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `catan-copilot-gamelogs-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  function downloadHistory() {
    const lines = moveHistory.map((e) => {
      const clock = new Date(e.t).toLocaleTimeString();
      return `${clock}  ${e.player ?? "?"}${e.mine ? " (you)" : ""}: ${e.text}`;
    });
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `catan-copilot-history-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  function getYouName() {
    var _a;
    const el = document.getElementsByClassName("web-header-username")[0];
    return ((_a = el == null ? void 0 : el.textContent) == null ? void 0 : _a.trim()) || null;
  }
  const BRIDGE_URL = "http://127.0.0.1:8137/state";
  let lastBridgePost = 0;
  function buildLiveSummary() {
    if (!tracker) return null;
    const you = tracker.youName;
    const deck = deckStatus(tracker);
    const players = [...tracker.players.values()].map((p) => ({
      name: p.name,
      isYou: p.name === you,
      vp: visibleVp(p),
      cards: p.serverCards ?? handTotal(p),
      pips: Math.round(productionTotal(expectedProduction(p)) * 36),
      devCards: p.devCards,
      knightsPlayed: p.knightsPlayed,
      hand: p.trackingHealth === "exact" ? p.hand : void 0,
      trackingHealth: p.trackingHealth ?? "incomplete"
    }));
    const fits = you ? rankLiveStrategies(tracker, you, strategyPriors(loadRecords())) : [];
    const gs = bridge.board ? bridge.toGameState() : null;
    let advice = gs ? advisePlacement(gs.state, gs.youPlayer, tracker.players.size) : null;
    const planning = computePlanning();
    if (advice && planning && gs) advice = planningAdvice(advice, planning, gs.state);
    return {
      at: (/* @__PURE__ */ new Date()).toISOString(),
      you,
      turn: {
        isMyTurn: bridge.isMyTurn,
        needsRoll: bridge.needsRoll,
        phase: bridge.turnState,
        currentPlayerColor: bridge.currentTurnColor
      },
      players,
      deck: {
        cardsLeft: 36 - deck.rollsIntoDeck,
        due: deck.due,
        cold: deck.cold,
        prob: Object.fromEntries([...deck.prob.entries()].map(([n, p]) => [n, +(p * 100).toFixed(0)]))
      },
      recommendedStrategy: fits[0] ? { name: fits[0].strategy.name, rationale: fits[0].rationale, simVp: +fits[0].simVp.toFixed(1) } : null,
      whereToBuild: advice ? { heading: advice.heading, spots: advice.spots.map((s) => s.label) } : null,
      autopilot: autopilot.view(),
      recentMoves: moveHistory.slice(-25).map((m) => ({ player: m.player, text: m.text, mine: m.mine }))
    };
  }
  function postLiveState() {
    const now = Date.now();
    if (now - lastBridgePost < 1500) return;
    lastBridgePost = now;
    try {
      const summary = buildLiveSummary();
      if (!summary) return;
      fetch(BRIDGE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(summary),
        keepalive: true
      }).catch(() => void 0);
    } catch {
    }
  }
  const rawEvents = /* @__PURE__ */ new Map();
  const decisionHistory = [];
  let handLedger = null;
  let restoredHandSnapshot = null;
  let historyComplete = false;
  let planningRevision = 0;
  let planningCache = null;
  const journalKey = () => `catanCopilot:ledger:${location.href}`;
  const boardKey = () => {
    var _a;
    return JSON.stringify(((_a = bridge.board) == null ? void 0 : _a.hexes.map((h) => [h.q, h.r, h.kind, h.token])) ?? []);
  };
  function syncLedger() {
    var _a, _b, _c;
    if (!(tracker == null ? void 0 : tracker.youName) || tracker.players.size !== 2 || bridge.myColor === null) return;
    const opponent = [...tracker.players.values()].find((p) => p.name !== tracker.youName);
    if (!handLedger || handLedger.you !== tracker.youName || handLedger.opponent !== opponent.name) {
      handLedger = new HandLedger(tracker.youName, opponent.name, historyComplete);
      for (const [id, event] of rawEvents) handLedger.record(id, event);
      if (restoredHandSnapshot) {
        handLedger.project(restoredHandSnapshot);
        restoredHandSnapshot = null;
      }
    }
    const ownCards = (_c = (_b = (_a = bridge.state.playerStates) == null ? void 0 : _a[String(bridge.myColor)]) == null ? void 0 : _b.resourceCards) == null ? void 0 : _c.cards;
    if (!Array.isArray(ownCards) || ownCards.some((id) => id < 1 || id > 5) || opponent.serverCards === null) {
      opponent.trackingHealth = "repairing";
      opponent.trackingReason = "Waiting for a complete private hand and opponent total";
      return;
    }
    if (!rawEvents.has(0) || rawEvents.size !== lastProcessedIndex + 1) {
      opponent.trackingHealth = historyComplete ? "repairing" : "incomplete";
      opponent.trackingReason = "Missing log rows; retained history must be completed before claiming an exact hand";
      return;
    }
    const mine = tracker.players.get(tracker.youName);
    const result = handLedger.project({ mine: { ...mine.hand }, opponentTotal: opponent.serverCards });
    opponent.trackingHealth = result.health;
    opponent.trackingReason = result.reason;
    if (result.opponent) {
      opponent.hand = result.opponent;
      opponent.uncertainty = 0;
      persistJournal();
    } else opponent.uncertainty = Math.max(1, Math.abs(handTotal(opponent) - opponent.serverCards));
  }
  function persistJournal() {
    try {
      localStorage.setItem(journalKey(), JSON.stringify({
        board: boardKey(),
        complete: historyComplete,
        events: [...rawEvents],
        decisions: decisionHistory,
        snapshot: handLedger == null ? void 0 : handLedger.lastSnapshot
      }));
    } catch {
    }
  }
  function recordDecision(decision) {
    var _a;
    if (!tracker) return;
    const previous = decisionHistory[decisionHistory.length - 1];
    if ((previous == null ? void 0 : previous.decision.kind) === "play-monopoly" && previous.decision.resource && !previous.outcome) {
      const between = [...rawEvents].filter(([id]) => id > previous.eventIndex).map(([, event]) => event);
      const played = between.some((e) => e.type === "use-dev" && e.card === "monopoly" && e.player === tracker.youName);
      const opponentTurn = between.some((e) => e.type === "roll" && e.player !== tracker.youName);
      const opponent = [...tracker.players.values()].find((p) => p.name !== tracker.youName);
      const before = previous.hands.find((p) => p.name === (opponent == null ? void 0 : opponent.name));
      if (played && !opponentTurn && (opponent == null ? void 0 : opponent.trackingHealth) === "exact" && before) {
        const resource = previous.decision.resource;
        const cards = before.hand[resource] - opponent.hand[resource];
        if (cards >= 0) previous.outcome = { confirmed: true, resource, cards, eventId: lastProcessedIndex };
      }
    }
    decisionHistory.push({
      t: Date.now(),
      eventIndex: lastProcessedIndex,
      decision,
      hands: [...tracker.players.values()].map((p) => ({
        name: p.name,
        hand: { ...p.hand },
        total: p.serverCards,
        health: p.trackingHealth ?? "incomplete",
        publicVp: visibleVp(p)
      })),
      buildings: bridge.buildings,
      roads: bridge.roads,
      position: (() => {
        const gs = bridge.toGameState();
        return gs ? structuredClone({ buildings: gs.state.buildings, roads: gs.state.roads }) : void 0;
      })(),
      planningInputs: structuredClone((_a = computePlanning()) == null ? void 0 : _a.inputs.map(({ settlementRoutes: settlementRoutes2, cityProduction, longestRoadPath, ...input }) => input)),
      devCardIds: bridge.myDevCardIds(),
      bankDevCards: bridge.bankDevCards,
      robberHex: bridge.robberHex
    });
    persistJournal();
  }
  function syncTrackerFromState() {
    var _a, _b, _c;
    if (!tracker) return;
    planningRevision++;
    const myColor = bridge.myColor;
    if (myColor !== null && !tracker.youName) {
      tracker.youName = bridge.colorToName.get(myColor) ?? tracker.youName;
    }
    for (const [color, name] of bridge.colorToName) {
      ensurePlayer(tracker, name, COLONIST_COLORS[color] ?? "#888");
      const p = tracker.players.get(name);
      const hand = bridge.handOf(color);
      p.serverCards = hand.total;
      p.serverVp = bridge.publicVp(color);
      if (color === myColor) {
        const cards = (_c = (_b = (_a = bridge.state.playerStates) == null ? void 0 : _a[String(color)]) == null ? void 0 : _b.resourceCards) == null ? void 0 : _c.cards;
        const exact = Array.isArray(cards) && cards.every((id) => id >= 1 && id <= 5);
        if (exact) for (const r of RESOURCES) p.hand[r] = hand.known[r] ?? 0;
        p.uncertainty = exact ? 0 : 1;
        p.trackingHealth = exact ? "exact" : "repairing";
      } else {
        reconcileHandWithTotal(p);
      }
      for (const [r, ratio] of Object.entries(bridge.bankRatios(color))) {
        p.bankRatio[r] = Math.min(p.bankRatio[r] ?? 4, ratio);
      }
    }
    if (myColor !== null) {
      const limit = bridge.discardLimit(myColor);
      if (limit !== null) tracker.discardLimit = limit;
    }
    syncLedger();
  }
  function domSaysYourTurn() {
    return domHasText(YOUR_TURN_BANNER) || rollPromptVisible();
  }
  function domSaysMoveRobber() {
    return domHasText(MOVE_ROBBER_BANNER);
  }
  function domSaysDiscard() {
    return domHasText(DISCARD_BANNER);
  }
  function domHasText(pattern) {
    try {
      const nodes = document.evaluate(
        `//*[not(ancestor::*[@data-index]) and not(ancestor::*[@id="catan-copilot"])]`,
        document.body,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null
      );
      for (let i = 0; i < nodes.snapshotLength; i++) {
        const el = nodes.snapshotItem(i);
        if (el.children.length > 2) continue;
        const text = (el.textContent ?? "").trim();
        if (text.length > 40) continue;
        if (pattern.test(text)) return true;
      }
    } catch {
    }
    return false;
  }
  function countKnightsInHand() {
    let n = 0;
    document.querySelectorAll("img").forEach((img) => {
      if (img.closest("[data-index]") || img.closest("#catan-copilot") || img.closest("[data-player-information-container]")) {
        return;
      }
      const label = `${img.getAttribute("alt") ?? ""} ${img.getAttribute("src") ?? ""}`;
      if (!/knight/i.test(label) || /largest/i.test(label)) return;
      const r = img.getBoundingClientRect();
      if (r.width === 0 || r.top < window.innerHeight * 0.55) return;
      n++;
    });
    return n;
  }
  function findChatScroller() {
    const row = document.querySelector("[data-index]");
    return row ? row.parentElement : null;
  }
  function computePlanning() {
    var _a, _b, _c;
    if ((planningCache == null ? void 0 : planningCache.revision) === planningRevision) return planningCache.value;
    if (!(tracker == null ? void 0 : tracker.youName) || !tracker.players.has(tracker.youName)) return null;
    const gs = bridge.board ? bridge.toGameState() : null;
    const order = bridge.colorOrder();
    const inputs = [];
    for (const [color, name] of bridge.colorToName) {
      const p = tracker.players.get(name);
      if (!p) continue;
      const pieces = bridge.piecesLeft(color);
      const pid = order.indexOf(color);
      const settlementsOnBoard = bridge.buildings.filter(
        (b) => b.colorId === color && b.kind === "settlement"
      ).length;
      let spotOpen = (pieces.roads ?? 1) > 0;
      if (gs && pid >= 0 && pid <= 3) {
        spotOpen = bestPlaceableNow(gs.state, pid) !== null;
      }
      const isYou = name === tracker.youName;
      const hiddenVp = isYou ? bridge.myDevCardIds().filter((id) => id === 12).length : Math.min(5, Math.max(0, p.devCards) * (5 / 25));
      inputs.push({
        name,
        playerId: pid,
        isYou,
        publicVp: bridge.publicVp(color),
        hiddenVp,
        settlementsLeft: pieces.settlements,
        citiesLeft: pieces.cities,
        roadsLeft: pieces.roads,
        settlementsOnBoard,
        settlementSpotOpen: spotOpen,
        knightsPlayed: p.knightsPlayed,
        longestRoadLen: bridge.longestRoad(color),
        hand: p.hand,
        production: gs && pid >= 0 && pid <= 3 ? playerProduction(gs.state, pid) : expectedProduction(p),
        cityProduction: gs ? gs.state.buildings.filter((b) => b.player === pid && b.kind === "settlement").map((b) => vertexIncome(gs.state, b.vertexId, 1)) : void 0,
        bankRatios: bridge.bankRatios(color),
        rollsPerTurn: tracker.players.size,
        holdsLargestArmy: (((_c = (_b = (_a = bridge.state.playerStates) == null ? void 0 : _a[String(color)]) == null ? void 0 : _b.victoryPointsState) == null ? void 0 : _c["3"]) ?? 0) > 0,
        holdsLongestRoad: bridge.holdsLongestRoad(color),
        knightsInHand: isYou ? bridge.myDevCardIds().filter((id) => id === 11).length : 0,
        playableKnights: isYou ? bridge.myDevCardIds().filter((id) => id === 11).length : 0,
        settlementRoutes: gs && pid >= 0 && pid <= 3 ? settlementRoutes(gs.state, pid) : void 0
      });
    }
    if (!inputs.some((p) => p.isYou)) return null;
    const targetRoad = Math.max(5, 1 + Math.max(...inputs.map((p) => p.longestRoadLen)));
    if (gs) for (const p of inputs) {
      if (p.playerId === void 0) continue;
      p.longestRoadPath = p.holdsLongestRoad ? null : roadBonusPath(gs.state, p.playerId, targetRoad, p.roadsLeft ?? 0);
    }
    const value = planPosition(tracker, tracker.youName, gs, { inputs, robberHex: bridge.robberHex, target: bridge.winTarget, devDeckLeft: bridge.bankDevCards });
    planningCache = { revision: planningRevision, value };
    return value;
  }
  function computeWinChances() {
    var _a;
    return ((_a = computePlanning()) == null ? void 0 : _a.victories) ?? [];
  }
  function scheduleRender() {
    if (renderTimer !== void 0) return;
    renderTimer = window.setTimeout(() => {
      renderTimer = void 0;
      if (tracker && overlay) {
        if (!tracker.youName) tracker.youName = getYouName();
        if (!tracker.youName && bridge.myColor !== null) {
          tracker.youName = bridge.colorToName.get(bridge.myColor) ?? null;
        }
        overlay.render(tracker, bridge);
        postLiveState();
      }
    }, 400);
  }
  window.addEventListener("message", (ev) => {
    const data = ev.data;
    if (ev.source !== window && ev.source !== null) return;
    if (!(data == null ? void 0 : data.__catan_copilot__)) return;
    if (data.dir && data.frame !== void 0) {
      const raw = data.raw;
      const decodes = data.decodes;
      if (capture.length < CAPTURE_LIMIT) {
        capture.push({ t: Date.now(), dir: data.dir, frame: data.frame, raw, decodes });
      }
      if (data.dir === "out") {
        const best = decodes ? Object.values(decodes).find((v) => v && typeof v === "object") : void 0;
        learner.recordOutbound(best ?? data.frame);
        scheduleRender();
      }
      return;
    }
    if (typeof data.type !== "number") return;
    if (data.type === STATE_EVENT.GAME_META || data.type === STATE_EVENT.INIT || data.type === STATE_EVENT.DIFF) {
      const prev = prevTurnColor;
      bridge.apply(data.type, data.payload);
      if (tracker && (data.type === STATE_EVENT.INIT || data.type === STATE_EVENT.DIFF)) {
        syncTrackerFromState();
        const turn = bridge.currentTurnColor;
        const myColor = bridge.myColor;
        if (turn !== null && myColor !== null) {
          if (prev === myColor && turn !== myColor) autopilot.onConfirm("end-turn");
          prevTurnColor = turn;
          autopilot.onTurnState(turn, myColor);
          if (bridge.isMyTurn && bridge.diceThrown) autopilot.onYouRolled();
        }
        if (myColor !== null) {
          const mineBuildings = bridge.buildings.filter((b) => b.colorId === myColor);
          const mine = mineBuildings.length;
          const myCities = mineBuildings.filter((b) => b.kind === "city").length;
          const myRoads = bridge.roads.filter((r) => r.colorId === myColor).length;
          if (mine > prevMyBuildings) pilotConfirm("build-settlement");
          if (myCities > prevMyCities) pilotConfirm("build-city");
          if (myRoads > prevMyRoads) pilotConfirm("build-road");
          prevMyBuildings = mine;
          prevMyCities = myCities;
          prevMyRoads = myRoads;
        }
      }
    }
    scheduleRender();
  });
  function processRow(el) {
    if (!tracker) return;
    const idxAttr = el.getAttribute("data-index");
    if (idxAttr === null) return;
    const idx = parseInt(idxAttr, 10);
    if (Number.isNaN(idx)) return;
    const ev = parseLogRow(el);
    const previous = rawEvents.get(idx);
    if (previous && JSON.stringify(previous) === JSON.stringify(ev)) return;
    lastProcessedIndex = Math.max(lastProcessedIndex, idx);
    rawEvents.set(idx, ev);
    if (!historyComplete && rawEvents.has(0) && rawEvents.size === lastProcessedIndex + 1) {
      const paid = new Set([...rawEvents.values()].filter((e) => e.type === "starting-resources").map((e) => e.player));
      if (paid.size === 2) {
        historyComplete = true;
        if (handLedger) handLedger.complete = true;
      }
    }
    handLedger == null ? void 0 : handLedger.record(idx, ev);
    const rebuilt = createTracker(tracker.youName);
    for (const [, event] of [...rawEvents].sort(([a], [b]) => a - b)) applyEvent(rebuilt, event);
    tracker = rebuilt;
    if (!previous || previous.type === "ignored") recordMove(ev);
    syncTrackerFromState();
    if (ev.type === "monopoly-steal" && ev.player === tracker.youName) {
      const action = [...decisionHistory].reverse().find((d) => d.decision.kind === "play-monopoly" && !d.outcome && d.eventIndex < idx);
      if (action) action.outcome = { confirmed: true, resource: ev.resource, cards: ev.count, eventId: idx };
    }
    persistJournal();
    const you = tracker.youName;
    if (you) {
      if (ev.type === "roll" && ev.player === you) {
        learner.confirm("roll");
        autopilot.onYouRolled();
      } else if (ev.type === "buy-dev" && ev.player === you) {
        learner.confirm("buy-dev");
        pilotConfirm("buy-dev");
      } else if (ev.type === "move-robber" && ev.player === you) {
        learner.confirm("move-robber");
        pilotConfirm("move-robber");
      } else if (ev.type === "discard" && ev.player === you) {
        learner.confirm("discard");
        pilotConfirm("discard");
      } else if (ev.type === "bank-trade" && ev.player === you) {
        pilotConfirm("bank-trade");
      } else if (ev.type === "use-knight" && ev.player === you) {
        learner.confirm("play-knight");
        autopilot.onConfirm("play-knight");
      } else if (ev.type === "use-dev" && ev.player === you) {
        if (ev.card === "monopoly") autopilot.onConfirm("play-monopoly");
        if (ev.card === "road-building") autopilot.onConfirm("play-road-building");
        if (ev.card === "year-of-plenty") autopilot.onConfirm("play-year-of-plenty");
        autopilot.markDevPlayed();
      }
    }
    if (ev.type === "game-over" && !gameRecorded) {
      gameRecorded = true;
      if (historyComplete) recordGameEnd(tracker);
      saveFullGameLog();
    }
    scheduleRender();
  }
  let gameStartTime = 0;
  function saveFullGameLog() {
    var _a;
    if (!tracker) return;
    const you = tracker.youName;
    const winnerEntry = [...tracker.players.values()].find((p) => visibleVp(p) >= bridge.winTarget);
    const winner = typeof tracker.gameOver === "string" ? tracker.gameOver : (winnerEntry == null ? void 0 : winnerEntry.name) ?? null;
    const fits = you ? rankLiveStrategies(tracker, you, strategyPriors(loadRecords())) : [];
    const log = {
      version: VERSION,
      at: (/* @__PURE__ */ new Date()).toISOString(),
      durationMs: gameStartTime ? Date.now() - gameStartTime : null,
      you,
      won: winner !== null && winner === you,
      winner,
      playerCount: tracker.players.size,
      settings: {
        friendlyRobber: bridge.friendlyRobber,
        victoryPointsToWin: bridge.winTarget,
        discardLimit: tracker.discardLimit
      },
      recommendedStrategy: ((_a = fits[0]) == null ? void 0 : _a.strategy.name) ?? null,
      board: bridge.board ? {
        tiles: bridge.board.hexes.map((h) => ({ q: h.q, r: h.r, kind: h.kind, token: h.token })),
        ports: bridge.board.vertices.filter((v) => v.port).map((v) => v.port.ratio === 2 ? `2:1 ${v.port.kind}` : "3:1").filter((p, i, a) => a.indexOf(p) === i)
      } : { tiles: [], ports: [] },
      finalPlayers: [...tracker.players.values()].map((p) => ({
        name: p.name,
        isYou: p.name === you,
        vp: visibleVp(p),
        cards: p.serverCards ?? handTotal(p),
        pips: Math.round(productionTotal(expectedProduction(p)) * 36),
        devCards: p.devCards,
        knightsPlayed: p.knightsPlayed
      })),
      // Final board positions: lets a post-game analysis see WHERE we settled
      // (pips, ports) — the move log alone can't explain a production deficit.
      buildings: (() => {
        const gs = bridge.board ? bridge.toGameState() : null;
        if (!gs) return void 0;
        return bridge.buildings.map((b) => ({
          player: bridge.colorToName.get(b.colorId) ?? null,
          kind: b.kind,
          label: describeVertex(gs.state, b.vertexId),
          pips: vertexPips(gs.state.board, b.vertexId)
        }));
      })(),
      moves: moveHistory.slice(),
      boardGeometry: bridge.board ?? void 0,
      complete: historyComplete && rawEvents.size === lastProcessedIndex + 1 && tracker.players.size >= 2 && winner !== null,
      events: [...rawEvents].sort(([a], [b]) => a - b).map(([id, event]) => ({ id, event })),
      decisions: decisionHistory.slice()
    };
    saveGameLog(log);
    try {
      fetch("http://127.0.0.1:8137/gamelog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(log),
        keepalive: true
      }).catch(() => void 0);
    } catch {
    }
  }
  function sweepExistingRows(scroller) {
    const rows = [...scroller.querySelectorAll("[data-index]")].sort(
      (a, b) => parseInt(a.getAttribute("data-index"), 10) - parseInt(b.getAttribute("data-index"), 10)
    );
    rows.forEach(processRow);
  }
  let observedScroller = null;
  function attach(scroller) {
    tracker = createTracker(getYouName());
    handLedger = null;
    restoredHandSnapshot = null;
    rawEvents.clear();
    decisionHistory.length = 0;
    historyComplete = bridge.turnState === 0 && bridge.buildings.length < 3;
    try {
      const saved = JSON.parse(localStorage.getItem(journalKey()) ?? "null");
      if ((saved == null ? void 0 : saved.board) === boardKey() && Array.isArray(saved.events)) {
        historyComplete = saved.complete === true;
        restoredHandSnapshot = saved.snapshot ?? null;
        if (Array.isArray(saved.decisions)) decisionHistory.push(...saved.decisions);
        for (const [id, event] of saved.events) {
          rawEvents.set(id, event);
          applyEvent(tracker, event);
        }
      }
    } catch {
    }
    planningRevision++;
    lastProcessedIndex = Math.max(-1, ...rawEvents.keys());
    syncTrackerFromState();
    observedScroller = scroller;
    gameRecorded = false;
    prevTurnColor = null;
    prevMyBuildings = 0;
    prevMyCities = 0;
    prevMyRoads = 0;
    moveHistory.length = 0;
    gameStartTime = Date.now();
    if (!overlay) {
      overlay = new Overlay(document, {
        captureCount: () => capture.length,
        onDownloadCapture: downloadCapture,
        getAutopilotView: () => autopilot.view(),
        getWinChances: () => computeWinChances(),
        getPlanning: () => computePlanning(),
        getRushView: () => ({ ...rushPilot.view(), active: rushActive(), pref: rushPref, modeSetting: bridge.modeSetting }),
        onSetRushPref: (pref) => {
          rushPref = pref;
          saveRushPref(pref);
          scheduleRender();
        },
        onToggleAutopilot: (on) => {
          autopilot.setEnabled(on);
          rushPilot.setEnabled(on);
          try {
            localStorage.setItem(AUTOPILOT_PREF, on ? "1" : "0");
          } catch {
          }
          scheduleRender();
        },
        needsRefresh: () => capture.length === 0,
        getHistory: () => moveHistory,
        onDownloadHistory: downloadHistory,
        gameLogCount: () => loadGameLogs().length,
        onDownloadGameLogs: downloadGameLogs
      });
    }
    sweepExistingRows(scroller);
    observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes.forEach((node) => {
          var _a;
          if (node instanceof Element) {
            if (node.hasAttribute("data-index")) processRow(node);
            else (_a = node.querySelectorAll) == null ? void 0 : _a.call(node, "[data-index]").forEach(processRow);
          }
        });
      }
    });
    observer.observe(scroller, { childList: true, subtree: true });
    scheduleRender();
  }
  function detach() {
    observer == null ? void 0 : observer.disconnect();
    observer = null;
    observedScroller = null;
    tracker = null;
    lastProcessedIndex = -1;
  }
  function watchForGame() {
    window.setInterval(() => {
      const scroller = findChatScroller();
      if (!observer && scroller) {
        attach(scroller);
      } else if (observer && !scroller) {
        detach();
      } else if (observer && scroller && scroller !== observedScroller) {
        detach();
        attach(scroller);
      }
    }, 2e3);
  }
  function rushTick() {
    if (!rushPilot.enabled || !tracker || !tracker.youName) return;
    rushPilot.setRobberPending(domSaysMoveRobber());
    rushPilot.setDiscardPending(domSaysDiscard());
    const gs = bridge.board ? bridge.toGameState() : null;
    let advice = gs ? advisePlacement(gs.state, gs.youPlayer, tracker.players.size) : null;
    const planning = computePlanning();
    if (advice && planning && gs) advice = planningAdvice(advice, planning, gs.state);
    const fits = rankLiveStrategies(tracker, tracker.youName, strategyPriors(loadRecords()));
    const colorOrder = bridge.colorOrder();
    const canRob = (player) => {
      if (!bridge.friendlyRobber) return true;
      const color = colorOrder[player];
      return color === void 0 || bridge.publicVp(color) >= 3;
    };
    rushPilot.tick({
      tracker,
      gs,
      advice,
      fit: fits[0] ?? null,
      robberHex: bridge.robberHex,
      canRob,
      piecesLeft: bridge.myColor !== null ? bridge.piecesLeft(bridge.myColor) : void 0
    });
    scheduleRender();
  }
  window.setInterval(() => {
    if (!tracker) return;
    if (!tracker.youName) tracker.youName = getYouName();
    syncTrackerFromState();
    if (!tracker.youName) return;
    if (rushActive()) {
      rushTick();
      return;
    }
    if (!autopilot.enabled) return;
    if (bridge.currentTurnColor !== null && bridge.myColor !== null) {
      autopilot.onTurnState(bridge.currentTurnColor, bridge.myColor);
      if (bridge.isMyTurn && bridge.diceThrown) autopilot.onYouRolled();
    }
    autopilot.noteDomTurn(domSaysYourTurn());
    autopilot.setRobberPending(domSaysMoveRobber());
    autopilot.setDiscardPending(domSaysDiscard());
    const gs = bridge.board ? bridge.toGameState() : null;
    let advice = gs ? advisePlacement(gs.state, gs.youPlayer, tracker.players.size) : null;
    const planning = computePlanning();
    if (advice && planning && gs) advice = planningAdvice(advice, planning, gs.state);
    const fits = rankLiveStrategies(tracker, tracker.youName, strategyPriors(loadRecords()));
    const colorOrder = bridge.colorOrder();
    const canRob = (player) => {
      if (!bridge.friendlyRobber) return true;
      const color = colorOrder[player];
      return color === void 0 || bridge.publicVp(color) >= 3;
    };
    autopilot.tick({
      tracker,
      gs,
      advice,
      fit: fits[0] ?? null,
      robberHex: bridge.robberHex,
      canRob,
      knightsInHand: countKnightsInHand(),
      bankDevCards: bridge.bankDevCards,
      piecesLeft: bridge.myColor !== null ? bridge.piecesLeft(bridge.myColor) : void 0,
      myDevCardIds: bridge.myDevCardIds(),
      tradeOffers: bridge.pendingTradeOffers(),
      winTarget: bridge.winTarget,
      planning: planning ?? void 0,
      playerCount: bridge.colorToName.size
    });
    if (bridge.myOpenOffer()) autopilot.onConfirm("propose-trade");
    scheduleRender();
  }, 1500);
  watchForGame();
})();
