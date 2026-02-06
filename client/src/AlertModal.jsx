import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { clsx } from 'clsx';
import { ExclamationTriangleIcon, CheckCircleIcon, InformationCircleIcon } from '@heroicons/react/24/outline';
import { translations } from './i18n';

const AlertModal = ({ isOpen, title, message, type = 'error', onClose, lang = 'en' }) => {
    const t = translations[lang];

    const getIcon = () => {
        switch (type) {
            case 'success': return <CheckCircleIcon className="w-10 h-10 text-emerald-500" />;
            case 'warning': return <ExclamationTriangleIcon className="w-10 h-10 text-amber-500" />;
            case 'error': 
            default: return <ExclamationTriangleIcon className="w-10 h-10 text-red-500" />;
        }
    };

    return (
        <AnimatePresence>
            {isOpen && (
                <div className="fixed inset-0 z-[80] flex items-center justify-center p-4" style={{ zIndex: 80 }}>
                    {/* Backdrop */}
                    <motion.div 
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" 
                        onClick={onClose}
                    />

                    {/* Modal Content - Island Style */}
                    <motion.div 
                        initial={{ opacity: 0, scale: 0.9, y: 20 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.9, y: 20 }}
                        transition={{ type: "spring", stiffness: 350, damping: 25 }}
                        className="relative bg-white/80 backdrop-blur-xl border border-white/40 shadow-[0_8px_32px_rgba(0,0,0,0.12)] rounded-[32px] p-6 w-full max-w-xs flex flex-col items-center gap-4 text-center select-none"
                    >
                        <div className="p-3 bg-white/50 rounded-full shadow-sm border border-white/20">
                            {getIcon()}
                        </div>
                        
                        <div className="space-y-1.5">
                            <h3 className="text-lg font-bold text-slate-800 tracking-tight">{title}</h3>
                            <p className="text-xs text-slate-500 font-medium leading-relaxed px-2 break-words max-h-40 overflow-y-auto custom-scrollbar">
                                {message}
                            </p>
                        </div>

                        <button 
                            onClick={onClose}
                            className={clsx(
                                "mt-2 w-full py-3 rounded-2xl font-bold text-sm transition-all shadow-lg active:scale-95",
                                type === 'error' ? "bg-red-500/90 hover:bg-red-500 text-white shadow-red-500/30" :
                                type === 'success' ? "bg-emerald-500/90 hover:bg-emerald-500 text-white shadow-emerald-500/30" :
                                "bg-indigo-500/90 hover:bg-indigo-500 text-white shadow-indigo-500/30"
                            )}
                        >
                            {t.close || "Close"}
                        </button>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
    );
};

export default AlertModal;
