export default function TurnIndicator({ isActive = false, subtle = false }) {
  return (
    <span
      className={`turn-indicator ${isActive ? 'turn-indicator-active' : ''} ${subtle ? 'turn-indicator-subtle' : ''}`}
      aria-hidden="true"
    />
  );
}
