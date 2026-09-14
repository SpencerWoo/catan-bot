import { readFileSync } from 'node:fs';

// Read-only historical audit. Text-only records are evidence of what happened,
// never inputs for invented exact hands or counterfactual win rates.
const logs = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const reports = logs.map((g, index) => {
  const mine = g.moves.filter((m) => m.mine);
  const firstCity = mine.findIndex((m) => m.text === 'built a city');
  const you = g.finalPlayers.find((p) => p.isYou);
  const opponent = g.finalPlayers.find((p) => !p.isYou);
  const missingSetup = mine.filter((m) => m.text === 'placed a settlement').length < 2;
  const incomplete = g.complete === false || !g.winner || missingSetup;
  return { index, at: g.at, won: g.won, incomplete,
    replayable: !!g.boardGeometry && !!g.decisions?.some((d) => d.planningInputs && d.position),
    productionPips: [you?.pips, opponent?.pips],
    devBuys: mine.filter((m) => m.text === 'bought a development card').length,
    devBuysBeforeFirstCity: mine.slice(0, firstCity < 0 ? undefined : firstCity).filter((m) => m.text === 'bought a development card').length,
    cities: mine.filter((m) => m.text === 'built a city').length,
    monopolies: mine.filter((m) => /monopoly/.test(m.text)).map((m) => m.text) };
});
const losses = reports.filter((g) => !g.won && !g.incomplete);
console.log(JSON.stringify({ games: logs.length, wins: reports.filter((g) => g.won && !g.incomplete).length,
  losses: losses.length, incomplete: reports.filter((g) => g.incomplete).length,
  lossesWithLowerProduction: losses.filter((g) => g.productionPips[0] < g.productionPips[1]).length,
  exactReplayable: reports.filter((g) => g.replayable).length, reports }, null, 2));
