import { AnimatePresence, motion } from 'framer-motion';
import Card from './Card.jsx';

export default function CardFlightLayer({ flight }) {
  return (
    <AnimatePresence>
      {flight ? (
        <motion.div
          key={flight.id ?? flight.card.instanceId ?? flight.card.id}
          className={`card-flight card-flight-${flight.kind}`}
          style={{
            '--flight-card-w': `${flight.from.width}px`,
            '--flight-card-h': `${flight.from.height}px`,
            '--pile-card-w': `${flight.from.width}px`,
            '--pile-card-h': `${flight.from.height}px`,
            '--flight-final-scale': flight.finalScale ?? flight.toScale ?? 1,
          }}
          initial={{
            opacity: 0.92,
            x: flight.from.x - flight.from.width / 2,
            y: flight.from.y - flight.from.height / 2,
            scale: 1,
            rotate: flight.fromRotate ?? 0,
          }}
          animate={{
            opacity: flight.kind === 'discard' ? [1, 1, 1, 1] : [0.92, 1, 1, 0.98],
            x: [
              flight.from.x - flight.from.width / 2,
              flight.mid.x - flight.from.width / 2,
              flight.to.x - flight.from.width / 2,
            ],
            y: [
              flight.from.y - flight.from.height / 2,
              flight.mid.y - flight.from.height / 2,
              flight.to.y - flight.from.height / 2,
            ],
            scale: [
              flight.fromScale ?? 1,
              flight.midScale ?? 1.02,
              flight.toScale ?? 1,
            ],
            rotate: [flight.fromRotate ?? 0, flight.midRotate ?? 0, flight.toRotate ?? 0],
          }}
          exit={
            flight.kind === 'discard'
              ? { opacity: 1, scale: flight.finalScale ?? flight.toScale ?? 1, transition: { duration: 0.08, ease: [0.22, 1, 0.36, 1] } }
              : { opacity: 0, scale: (flight.toScale ?? 1) * 0.98 }
          }
          transition={{
            opacity: { duration: flight.duration ?? 0.3, ease: 'easeOut' },
            x: { duration: flight.duration ?? 0.3, ease: [0.18, 0.92, 0.2, 1] },
            y: { duration: flight.duration ?? 0.3, ease: [0.18, 0.92, 0.2, 1] },
            scale: { duration: flight.duration ?? 0.3, ease: [0.22, 1, 0.36, 1] },
            rotate: { duration: flight.duration ?? 0.3, ease: [0.22, 1, 0.36, 1] },
          }}
        >
          <Card card={flight.card} faceDown={flight.faceDown} size="pile" />
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
