import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { XMarkIcon, ChevronUpIcon, ChevronDownIcon, PlayIcon, PauseIcon, TrashIcon, CheckCircleIcon, ExclamationCircleIcon } from '@heroicons/react/24/outline';
import clsx from 'clsx';
import { translations } from '../i18n';

// --- Circular Progress Indicator (Top-Right) ---
export const CircularProgress = ({ progress, onClick, activeCount }) => {
    if (!progress && activeCount === 0) return null;

    // Use total percentage if available, otherwise just spin or show active count
    // If progress is null but activeCount > 0, we can show an indeterminate spinner or just the count.
    
    const percentage = progress && progress.total > 0 
        ? Math.round(((progress.current - 1) / progress.total) * 100) 
        : 0; // Simplified global progress
    
    // Better calculation: We will get detailed stats from the manager context in the future.
    // For now, let's just use the props passed from App.jsx if simpler.
    // Actually, the new Dashboard handles its own state, so App.jsx might pass `tasks`.

    return (
        <button 
            onClick={onClick}
            className="relative w-9 h-9 flex items-center justify-center rounded-full bg-slate-100 hover:bg-slate-200 transition-colors group"
        >
            <svg className="w-full h-full -rotate-90 p-1" viewBox="0 0 36 36">
                <path className="text-slate-300" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="currentColor" strokeWidth="3" />
                <path 
                    className="text-indigo-600 transition-all duration-300 ease-linear" 
                    strokeDasharray={`${percentage}, 100`} 
                    d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" 
                    fill="none" 
                    stroke="currentColor" 
                    strokeWidth="3" 
                />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
                {activeCount > 0 ? (
                    <span className="text-[10px] font-bold text-indigo-600">{activeCount}</span>
                ) : (
                    <CheckCircleIcon className="w-4 h-4 text-emerald-500" />
                )}
            </div>
        </button>
    );
};

// --- Helper: Format Speed ---
const formatSpeed = (bytesPerSec) => {
    if (!bytesPerSec) return '0 KB/s';
    if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
    return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
};

// --- Helper: Format Size ---
const formatSize = (bytes) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

// --- Dashboard Component ---
const TransferDashboard = ({ tasks, isOpen, onClose, onClearCompleted, lang = 'zh' }) => {
    const t = translations[lang];
    // Tasks: Array of { id, name, type, status: 'pending'|'active'|'done'|'error', progress: 0-100, speed, currentBytes, totalBytes }

    // Sort: Active first, then pending, then done/error
    const sortedTasks = useMemo(() => {
        const order = { 'active': 0, 'pending': 1, 'error': 2, 'done': 3 };
        return [...tasks].sort((a, b) => order[a.status] - order[b.status]);
    }, [tasks]);

    const activeCount = tasks.filter(t => t.status === 'active' || t.status === 'pending').length;

    return (
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    initial={{ opacity: 0, scale: 0.95, y: -20 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, y: -20 }}
                    transition={{ type: 'spring', duration: 0.4 }}
                    className="fixed inset-0 z-[60] flex items-start justify-center pt-20 px-4 pointer-events-none"
                >
                    {/* Backdrop (Click to close) */}
                    <div className="absolute inset-0 bg-black/10 backdrop-blur-sm pointer-events-auto" onClick={onClose} />

                    {/* Main Card */}
                    <div className="relative w-full max-w-lg max-h-[70vh] flex flex-col pointer-events-auto shadow-2xl rounded-3xl overflow-hidden border border-white/40 ring-1 ring-black/5 bg-white/80 backdrop-blur-xl dark:bg-slate-900/80 dark:border-slate-700/50">
                        {/* Header */}
                        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200/50 dark:border-slate-700/50">
                            <div className="flex items-center gap-3">
                                <div className="p-2 bg-indigo-500/10 rounded-full">
                                    {activeCount > 0 ? (
                                        <div className="w-5 h-5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                                    ) : (
                                        <CheckCircleIcon className="w-5 h-5 text-indigo-500" />
                                    )}
                                </div>
                                <div>
                                    <h3 className="font-semibold text-slate-800 dark:text-slate-100">{t.transfers}</h3>
                                    <p className="text-xs text-slate-500 dark:text-slate-400">
                                        {t.transfersStatus.replace('{active}', activeCount).replace('{completed}', tasks.length - activeCount)}
                                    </p>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                {tasks.some(t => t.status === 'done' || t.status === 'error') && (
                                    <button 
                                        onClick={onClearCompleted}
                                        className="text-xs font-medium text-slate-500 hover:text-red-500 px-2 py-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                                    >
                                        {t.clearDone}
                                    </button>
                                )}
                                <button onClick={onClose} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-full text-slate-500 transition-colors">
                                    <XMarkIcon className="w-5 h-5" />
                                </button>
                            </div>
                        </div>

                        {/* Task List */}
                        <div className="flex-1 overflow-y-auto p-2 scroll-smooth">
                            {tasks.length === 0 ? (
                                <div className="py-12 flex flex-col items-center justify-center text-slate-400">
                                    <CheckCircleIcon className="w-12 h-12 mb-2 opacity-50" />
                                    <p className="text-sm">{t.noTransfers}</p>
                                </div>
                            ) : (
                                <div className="space-y-2">
                                    {sortedTasks.map(task => (
                                        <div 
                                            key={task.id} 
                                            className={clsx(
                                                "group relative p-3 rounded-2xl border transition-all",
                                                task.status === 'active' 
                                                    ? "bg-white/60 dark:bg-slate-800/60 border-indigo-200/50 dark:border-indigo-500/30 shadow-sm" 
                                                    : "bg-transparent border-transparent hover:bg-white/40 dark:hover:bg-slate-800/40"
                                            )}
                                        >
                                            <div className="flex items-center justify-between mb-2">
                                                <div className="flex items-center gap-3 min-w-0">
                                                    {/* File Type Icon Placeholder */}
                                                    <div className={clsx(
                                                        "w-10 h-10 rounded-xl flex items-center justify-center shrink-0",
                                                        task.status === 'error' ? "bg-red-50 text-red-500" : "bg-indigo-50 text-indigo-500"
                                                    )}>
                                                        {task.status === 'error' ? (
                                                            <ExclamationCircleIcon className="w-6 h-6" />
                                                        ) : (
                                                             <span className="text-xs font-bold uppercase">{task.name.split('.').pop().slice(0,3)}</span>
                                                        )}
                                                    </div>
                                                    
                                                    <div className="min-w-0">
                                                        <p className="text-sm font-medium text-slate-700 dark:text-slate-200 truncate pr-4" title={task.name}>
                                                            {task.name}
                                                        </p>
                                                        <div className="flex items-center gap-2 text-[10px] text-slate-400 font-mono mt-0.5">
                                                            {task.status === 'active' && (
                                                                <>
                                                                    <span className="text-indigo-500">{formatSpeed(task.speed)}</span>
                                                                    <span>•</span>
                                                                </>
                                                            )}
                                                            <span>{formatSize(task.currentBytes || 0)} / {formatSize(task.totalBytes || 0)}</span>
                                                        </div>
                                                    </div>
                                                </div>

                                                {/* Status / Action */}
                                                <div className="shrink-0">
                                                    {task.status === 'pending' && <span className="text-xs text-slate-400 bg-slate-100 px-2 py-1 rounded-full">{t.pending}</span>}
                                                    {task.status === 'done' && <CheckCircleIcon className="w-6 h-6 text-emerald-500" />}
                                                    {task.status === 'error' && <span className="text-xs text-red-500">{t.failed}</span>}
                                                </div>
                                            </div>

                                            {/* Progress Bar */}
                                            {(task.status === 'active' || task.status === 'pending') && (
                                                <div className="w-full h-1.5 bg-slate-100 dark:bg-slate-700/50 rounded-full overflow-hidden">
                                                    <motion.div 
                                                        className={clsx("h-full rounded-full", task.status === 'pending' ? "bg-slate-300 w-full animate-pulse" : "bg-indigo-500")}
                                                        initial={{ width: 0 }}
                                                        animate={{ 
                                                            width: task.status === 'pending' ? '100%' : `${Math.min((task.currentBytes / Math.max(task.totalBytes, 1)) * 100, 100)}%` 
                                                        }}
                                                        transition={{ duration: 0.2 }}
                                                    />
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                        
                        {/* Footer (Total Stats) */}
                        {activeCount > 0 && (
                            <div className="bg-slate-50/50 dark:bg-slate-800/50 px-6 py-3 text-xs text-slate-500 flex justify-between border-t border-slate-200/50">
                                <span>{t.totalSpeed.replace('{speed}', formatSpeed(tasks.reduce((acc, t) => acc + (t.status === 'active' ? (t.speed || 0) : 0), 0)))}</span>
                                <span>{t.remainingFiles.replace('{count}', activeCount)}</span>
                            </div>
                        )}
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};

export default TransferDashboard;
