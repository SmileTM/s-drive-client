import React from 'react';
import { motion } from 'framer-motion';
import { XMarkIcon, DocumentIcon, FolderIcon } from '@heroicons/react/24/outline';
import { translations } from './i18n';

const formatSize = (bytes) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const DetailsModal = ({ file, driveName, onClose, lang = 'zh' }) => {
    const t = translations[lang];

    const isFolder = file.isDirectory;
    const sizeDisplay = isFolder 
        ? (file.itemCount !== undefined ? t.items.replace('{count}', file.itemCount) : '-')
        : formatSize(file.size);
    
    // Format Date
    const dateDisplay = new Date(file.mtime).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });

    return (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm" onClick={onClose}>
            <motion.div 
                initial={{ opacity: 0, scale: 0.95, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 10 }}
                onClick={(e) => e.stopPropagation()}
                className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden"
            >
                {/* Header */}
                <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
                    <h3 className="font-semibold text-slate-800">{t.fileInfo}</h3>
                    <button onClick={onClose} className="p-1 rounded-full hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors">
                        <XMarkIcon className="w-5 h-5" />
                    </button>
                </div>

                {/* Content */}
                <div className="p-6">
                    {/* Icon & Name */}
                    <div className="flex flex-col items-center mb-6">
                        <div className="w-20 h-20 bg-indigo-50 rounded-2xl flex items-center justify-center mb-3 shadow-inner text-indigo-500">
                            {isFolder ? <FolderIcon className="w-10 h-10" /> : <DocumentIcon className="w-10 h-10" />}
                        </div>
                        <h2 className="text-lg font-medium text-slate-800 text-center break-all px-2">{file.name}</h2>
                        <p className="text-xs text-slate-400 mt-1">{isFolder ? t.folder : t.file}</p>
                    </div>

                    {/* Info Grid */}
                    <div className="space-y-4">
                        <div className="flex justify-between items-start text-sm">
                            <span className="text-slate-400 shrink-0">{t.type}</span>
                            <span className="text-slate-700 font-medium text-right break-all pl-4">
                                {isFolder ? t.folder : (file.type || 'Unknown')}
                            </span>
                        </div>
                        <div className="w-full h-px bg-slate-50" />
                        
                        <div className="flex justify-between items-start text-sm">
                            <span className="text-slate-400 shrink-0">{t.location}</span>
                            <span className="text-slate-700 font-medium text-right pl-4">{driveName}</span>
                        </div>
                        <div className="w-full h-px bg-slate-50" />

                        <div className="flex justify-between items-start text-sm">
                            <span className="text-slate-400 shrink-0">{t.path}</span>
                            <span className="text-slate-700 font-medium text-right break-all pl-4 font-mono text-xs">{file.path}</span>
                        </div>
                        <div className="w-full h-px bg-slate-50" />

                        <div className="flex justify-between items-start text-sm">
                            <span className="text-slate-400 shrink-0">{t.size}</span>
                            <span className="text-slate-700 font-medium text-right pl-4">{sizeDisplay}</span>
                        </div>
                        <div className="w-full h-px bg-slate-50" />

                        <div className="flex justify-between items-start text-sm">
                            <span className="text-slate-400 shrink-0">{t.modified}</span>
                            <span className="text-slate-700 font-medium text-right pl-4">{dateDisplay}</span>
                        </div>
                    </div>
                </div>

                {/* Footer */}
                <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 flex justify-center">
                    <button 
                        onClick={onClose}
                        className="w-full py-2.5 bg-white border border-slate-200 text-slate-600 rounded-xl font-medium hover:bg-slate-50 hover:border-slate-300 transition-all text-sm shadow-sm"
                    >
                        {t.close}
                    </button>
                </div>
            </motion.div>
        </div>
    );
};

export default DetailsModal;
