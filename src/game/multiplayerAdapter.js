// Camada reservada para integrar Socket.io futuramente sem misturar rede com regras locais.
export function createOfflineMultiplayerAdapter() {
  return {
    mode: 'offline',
    connect: () => Promise.resolve(),
    sendMove: () => undefined,
    onMove: () => undefined,
  };
}
