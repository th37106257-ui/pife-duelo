import { AnimatePresence, motion } from 'framer-motion';

export default function ToastMessage({ toast }) {
  return (
    <AnimatePresence>
      {toast ? (
        <motion.div
          key={toast.id}
          className="toast-message"
          initial={{ opacity: 0, y: -14, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -10, scale: 0.96 }}
          transition={{ duration: 0.22 }}
        >
          {toast.message}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
