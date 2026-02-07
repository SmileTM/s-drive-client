import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { clsx } from 'clsx';
import { translations } from '../i18n';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';

const ConflictModal = ({ isOpen, fileName, onResolve, onCancel, lang = 'en' }) => {
    const [applyToAll, setApplyToAll] = useState(false);
    const t = translations[lang];

    if (!isOpen) return null;

    const handleAction = (action) => {
        onResolve(action, applyToAll);
        // Reset state for next time (though typically component unmounts/remounts or props change)
        setApplyToAll(false);
    };

    return (
        <AnimatePresence>
            <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
            >
                <motion.div 
                    initial={{ opacity: 0, scale: 0.95, y: 10 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, y: 10 }}
                    transition={{ type: "spring", stiffness: 400, damping: 30 }}
                    className="bg-white/90 backdrop-blur-2xl dark:bg-slate-900/90 rounded-[32px] shadow-2xl w-full max-w-sm overflow-hidden border border-white/20 dark:border-slate-700/50 p-6 flex flex-col gap-4 text-center"
                >
                    <div className="w-12 h-12 bg-amber-100 dark:bg-amber-900/30 rounded-full flex items-center justify-center mx-auto text-amber-500">
                        <ExclamationTriangleIcon className="w-7 h-7" />
                    </div>

                    <div className="space-y-2">
                        <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-100">{t.conflictTitle}</h3>
                        <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed px-2 break-all">
                            {t.conflictMessage.replace('{file}', fileName)}
                        </p>
                    </div>

                    {/* Apply to all checkbox */}
                    <div className="flex items-center justify-center gap-2 py-2">
                        <label className="flex items-center gap-2 cursor-pointer text-sm text-slate-600 dark:text-slate-300 select-none">
                            <input 
                                type="checkbox" 
                                checked={applyToAll}
                                onChange={(e) => setApplyToAll(e.target.checked)}
                                className="w-4 h-4 rounded border-slate-300 text-indigo-500 focus:ring-indigo-500"
                            />
                            {t.applyToAll}
                        </label>
                    </div>

                    <div className="flex flex-col gap-3 w-full mt-2">
                         <button 
                            onClick={() => handleAction('overwrite')}
                            className="w-full py-3 bg-indigo-500 hover:bg-indigo-600 text-white rounded-2xl font-medium transition-colors shadow-lg shadow-indigo-200 dark:shadow-none"
                        >
                            {t.overwrite}
                        </button>
                        
                        <div className="grid grid-cols-2 gap-3">
                             <button 
                                onClick={() => handleAction('skip')}
                                className="w-full py-3 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-2xl font-medium hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                            >
                                {t.skip}
                            </button>
                            <button 
                                onClick={onCancel}
                                className="w-full py-3 bg-transparent border border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 rounded-2xl font-medium hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                            >
                                {t.cancel}
                            </button>
                        </div>
                    </div>
                </motion.div>
            </motion.div>
        </AnimatePresence>
    );
};

export default ConflictModal;
