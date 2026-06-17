import { AnimatePresence, motion } from 'framer-motion';
import { memo } from 'react';

function ActionHistory({ actions = [] }) {
  const recentActions = actions.slice(0, 2);

  return (
    <div className="action-history" aria-label="Historico recente">
      <AnimatePresence initial={false}>
        {recentActions.map((action) => (
          <motion.span
            key={action.id}
            className="action-history-item"
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            {action.message}
          </motion.span>
        ))}
      </AnimatePresence>
    </div>
  );
}

export default memo(ActionHistory);
