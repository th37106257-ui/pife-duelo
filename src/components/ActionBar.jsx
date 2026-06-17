export default function ActionBar({
  handMode,
  canMoveLeft,
  canMoveRight,
  onAutoArrange,
  onToggleManual,
  onMoveLeft,
  onMoveRight,
}) {
  return (
    <nav className="action-bar" aria-label="Acoes do jogador">
      <div className="hand-tools" aria-label="Organizacao da mao">
        <button type="button" onClick={onAutoArrange} className={`tool-button ${handMode === 'auto' ? 'tool-active' : ''}`}>
          Auto
        </button>
        <button type="button" onClick={onToggleManual} className={`tool-button ${handMode === 'manual' ? 'tool-active' : ''}`}>
          Manual
        </button>
        <button type="button" disabled={!canMoveLeft} onClick={onMoveLeft} className="tool-button tool-arrow" aria-label="Mover carta para esquerda">
          {'<'}
        </button>
        <button type="button" disabled={!canMoveRight} onClick={onMoveRight} className="tool-button tool-arrow" aria-label="Mover carta para direita">
          {'>'}
        </button>
        <span className="action-help">
          {handMode === 'manual' ? 'arraste para ordenar' : 'toque carta + descarte'}
        </span>
      </div>
    </nav>
  );
}
