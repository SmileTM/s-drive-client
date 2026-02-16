import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { XMarkIcon, DocumentIcon, PhotoIcon, VideoCameraIcon, FolderIcon, ArrowUturnUpIcon, FolderPlusIcon } from '@heroicons/react/24/outline';
import api from '../api';
import InputModal from '../InputModal';

const ShareReceiver = ({ isOpen, onClose, onUpload, drives, activeDrive, lang }) => {
    const [sharedFiles, setSharedFiles] = useState([]);
    const [selectedDrive, setSelectedDrive] = useState(activeDrive);
    const [targetPath, setTargetPath] = useState('/');
    const [folders, setFolders] = useState([]);
    const [loadingFolders, setLoadingFolders] = useState(false);

    // New Folder Modal State
    const [isInputModalOpen, setIsInputModalOpen] = useState(false);

    useEffect(() => {
        const handleShare = (e) => {
            const items = e.detail?.items || [];
            if (items.length > 0) {
                setSharedFiles(items);
            }
        };

        window.addEventListener('appSendIntentReceived', handleShare);
        return () => window.removeEventListener('appSendIntentReceived', handleShare);
    }, []);

    useEffect(() => {
        // Reset path when drive changes
        setTargetPath('/');
    }, [selectedDrive]);

    useEffect(() => {
        if (!isOpen) return;
        loadFolders();
    }, [selectedDrive, targetPath, isOpen]);

    const loadFolders = async () => {
        if (!selectedDrive) return;
        setLoadingFolders(true);
        try {
            const items = await api.getFiles(targetPath, selectedDrive);
            if (Array.isArray(items)) {
                setFolders(items.filter(i => i.isDirectory));
            } else {
                setFolders([]);
            }
        } catch (e) {
            console.error("[ShareReceiver] Failed to load folders", e);
            setFolders([]);
        } finally {
            setLoadingFolders(false);
        }
    };

    const handleNavigate = (folderName) => {
        if (folderName === '..') {
            if (targetPath === '/') return;
            const parts = targetPath.split('/').filter(p => p);
            parts.pop();
            const newPath = parts.length === 0 ? '/' : `/${parts.join('/')}`;
            setTargetPath(newPath);
        } else {
            const newPath = targetPath === '/' ? `/${folderName}` : `${targetPath}/${folderName}`;
            setTargetPath(newPath);
        }
    };

    const handleCreateFolder = async (folderName) => {
        if (!folderName.trim()) return;

        try {
            setLoadingFolders(true);
            const cleanName = folderName.trim();
            const newPath = targetPath === '/' ? `/${cleanName}` : `${targetPath}/${cleanName}`;

            await api.createFolder(newPath, selectedDrive);
            await loadFolders(); // Refresh list
        } catch (e) {
            console.error("[ShareReceiver] Failed to create folder", e);
            alert("Failed to create folder");
        } finally {
            setLoadingFolders(false);
        }
    };

    const handleConfirm = () => {
        onUpload(sharedFiles, selectedDrive, targetPath);
        setSharedFiles([]);
    };

    if (!isOpen) return null;

    const totalSize = sharedFiles.reduce((acc, f) => acc + f.size, 0);

    const folderNamePrompt = {
        zh: '新建文件夹',
        en: 'New Folder'
    }[lang] || 'New Folder';

    return (
        <AnimatePresence>
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
                <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[90vh]"
                >
                    {/* Header */}
                    <div className="p-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between bg-slate-50/50 dark:bg-slate-800/50">
                        <h3 className="font-semibold text-lg text-slate-800 dark:text-slate-100">
                            Receive Files
                        </h3>
                        <button
                            onClick={() => onClose()}
                            className="p-2 -mr-2 rounded-full hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                        >
                            <XMarkIcon className="w-5 h-5 text-slate-500" />
                        </button>
                    </div>

                    {/* Content */}
                    <div className="p-4 overflow-y-auto flex-1 relative">
                        <div className="mb-4">
                            <p className="text-sm text-slate-500 mb-2">Files to upload ({sharedFiles.length})</p>
                            <div className="bg-slate-50 dark:bg-slate-800 rounded-xl p-2 max-h-32 overflow-y-auto space-y-2">
                                {sharedFiles.map((file, i) => (
                                    <div key={i} className="flex items-center gap-3 p-2 bg-white dark:bg-slate-700 rounded-lg shadow-sm border border-slate-100 dark:border-slate-600">
                                        <div className="shrink-0 w-8 h-8 bg-indigo-50 dark:bg-indigo-900/30 rounded-lg flex items-center justify-center">
                                            {file.mimeType?.startsWith('image') ? (
                                                <PhotoIcon className="w-4 h-4 text-indigo-500" />
                                            ) : file.mimeType?.startsWith('video') ? (
                                                <VideoCameraIcon className="w-4 h-4 text-indigo-500" />
                                            ) : (
                                                <DocumentIcon className="w-4 h-4 text-indigo-500" />
                                            )}
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <p className="text-sm font-medium text-slate-700 dark:text-slate-200 truncate">
                                                {file.name}
                                            </p>
                                            <p className="text-xs text-slate-400">
                                                {(file.size / 1024 / 1024).toFixed(2)} MB
                                            </p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                                    Save to Drive
                                </label>
                                <select
                                    value={selectedDrive}
                                    onChange={(e) => setSelectedDrive(e.target.value)}
                                    className="w-full p-2.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                                >
                                    {drives.map(d => (
                                        <option key={d.id} value={d.id}>{d.name} ({d.type})</option>
                                    ))}
                                </select>
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                                    Select Folder: <span className="text-indigo-600 font-mono text-xs ml-1">{targetPath}</span>
                                </label>
                                <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden h-40 flex flex-col relative">
                                    <div className="bg-slate-50 dark:bg-slate-800 p-2 border-b border-slate-200 dark:border-slate-700 flex gap-2 items-center">
                                        <button
                                            onClick={() => handleNavigate('..')}
                                            disabled={targetPath === '/'}
                                            className="p-1 hover:bg-white dark:hover:bg-slate-700 rounded disabled:opacity-30 transition-colors"
                                        >
                                            <ArrowUturnUpIcon className="w-4 h-4 text-slate-600 dark:text-slate-400" />
                                        </button>
                                        <span className="text-xs text-slate-500 flex-1 truncate">
                                            {targetPath}
                                        </span>
                                        <button
                                            onClick={() => setIsInputModalOpen(true)}
                                            className="p-1 hover:bg-white dark:hover:bg-slate-700 rounded transition-colors text-indigo-600 dark:text-indigo-400"
                                            title="New Folder"
                                        >
                                            <FolderPlusIcon className="w-4 h-4" />
                                        </button>
                                    </div>
                                    <div className="flex-1 overflow-y-auto p-1 bg-white dark:bg-slate-900">
                                        {loadingFolders ? (
                                            <div className="flex items-center justify-center h-full">
                                                <div className="w-5 h-5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
                                            </div>
                                        ) : folders.length === 0 ? (
                                            <div className="flex items-center justify-center h-full text-xs text-slate-400">
                                                No subfolders
                                            </div>
                                        ) : (
                                            <div className="space-y-0.5">
                                                {folders.map((f, i) => (
                                                    <div
                                                        key={i}
                                                        onClick={() => handleNavigate(f.name)}
                                                        className="flex items-center gap-2 p-2 hover:bg-slate-50 dark:hover:bg-slate-800 rounded cursor-pointer transition-colors"
                                                    >
                                                        <FolderIcon className="w-4 h-4 text-yellow-500" />
                                                        <span className="text-sm text-slate-700 dark:text-slate-300 truncate">{f.name}</span>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Footer */}
                    <div className="p-4 border-t border-slate-100 dark:border-slate-800 flex justify-end gap-3 bg-slate-50/50 dark:bg-slate-800/50">
                        <button
                            onClick={() => onClose()}
                            className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-800 hover:bg-slate-200 rounded-lg transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleConfirm}
                            className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg shadow-sm shadow-indigo-200 transition-all hover:scale-105 active:scale-95"
                        >
                            Upload {(totalSize / 1024 / 1024).toFixed(1)} MB
                        </button>
                    </div>
                </motion.div>

                {/* Re-using the themed InputModal for folder creation */}
                <InputModal
                    isOpen={isInputModalOpen}
                    title={folderNamePrompt}
                    onConfirm={handleCreateFolder}
                    onClose={() => setIsInputModalOpen(false)}
                    lang={lang}
                />
            </div>
        </AnimatePresence>
    );
};

export default ShareReceiver;
