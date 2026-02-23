import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { XMarkIcon, DocumentIcon, PhotoIcon, VideoCameraIcon, FolderIcon, ArrowUturnUpIcon, FolderPlusIcon, ServerStackIcon, ChevronDownIcon } from '@heroicons/react/24/outline';
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

    // Drive Selection Dropdown State
    const [isDriveSelectOpen, setIsDriveSelectOpen] = useState(false);

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
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 dark:bg-black/60 backdrop-blur-xl">
                <motion.div
                    initial={{ opacity: 0, y: 30, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 30, scale: 0.95 }}
                    transition={{ type: "spring", bounce: 0.3, duration: 0.6 }}
                    className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-3xl rounded-[2.5rem] shadow-[0_20px_60px_-15px_rgba(0,0,0,0.3)] ring-1 ring-black/5 dark:ring-white/10 w-full max-w-md overflow-hidden flex flex-col max-h-[90vh]"
                >
                    {/* Floating Header */}
                    <div className="px-6 pt-6 pb-2 flex items-center justify-between">
                        <h3 className="font-bold tracking-tight text-xl text-slate-800 dark:text-slate-100 ml-2">
                            Receive Files
                        </h3>
                        <button
                            onClick={() => onClose()}
                            className="p-2.5 rounded-full bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                        >
                            <XMarkIcon className="w-5 h-5 text-slate-500 dark:text-slate-400" />
                        </button>
                    </div>

                    {/* Content */}
                    <div className="px-6 py-4 overflow-y-auto flex-1 relative custom-scrollbar">
                        <div className="mb-6">
                            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3 ml-2">Files to upload ({sharedFiles.length})</p>
                            <div className="bg-slate-100/50 dark:bg-slate-800/50 rounded-3xl p-2 max-h-36 overflow-y-auto space-y-2 relative shadow-inner">
                                {sharedFiles.map((file, i) => (
                                    <div key={i} className="flex items-center gap-4 p-2.5 bg-white dark:bg-slate-700/80 rounded-2xl shadow-sm border border-black/5 dark:border-white/5">
                                        <div className="shrink-0 w-12 h-12 bg-indigo-50 dark:bg-indigo-900/30 rounded-xl flex items-center justify-center">
                                            {file.mimeType?.startsWith('image') ? (
                                                <PhotoIcon className="w-6 h-6 text-indigo-500" />
                                            ) : file.mimeType?.startsWith('video') ? (
                                                <VideoCameraIcon className="w-6 h-6 text-indigo-500" />
                                            ) : (
                                                <DocumentIcon className="w-6 h-6 text-indigo-500" />
                                            )}
                                        </div>
                                        <div className="min-w-0 flex-1 pl-1">
                                            <p className="text-sm font-semibold text-slate-800 dark:text-slate-200 truncate">
                                                {file.name}
                                            </p>
                                            <p className="text-xs font-medium text-slate-400 mt-0.5">
                                                {(file.size / 1024 / 1024).toFixed(2)} MB
                                            </p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        <div className="space-y-6">
                            <div className="relative">
                                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3 ml-2">
                                    Save to Drive
                                </label>
                                <div className="relative">
                                    <button
                                        onClick={() => setIsDriveSelectOpen(!isDriveSelectOpen)}
                                        className="w-full pl-5 pr-12 py-4 bg-slate-100/50 dark:bg-slate-800/50 rounded-3xl text-sm font-semibold text-slate-800 dark:text-slate-200 text-left transition-all hover:bg-slate-200/50 dark:hover:bg-slate-700/50 active:scale-[0.98] outline-none flex items-center justify-between"
                                    >
                                        <div className="flex items-center gap-3 truncate">
                                            <ServerStackIcon className="w-5 h-5 text-indigo-500" />
                                            <span className="truncate">
                                                {drives.find(d => d.id === selectedDrive)?.name || 'Select Drive'}
                                                <span className="text-slate-400 font-normal ml-2">
                                                    ({drives.find(d => d.id === selectedDrive)?.type})
                                                </span>
                                            </span>
                                        </div>
                                        <div className="absolute right-5 pointer-events-none transition-transform duration-200" style={{ transform: isDriveSelectOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}>
                                            <ChevronDownIcon className="w-5 h-5 text-slate-400" />
                                        </div>
                                    </button>

                                    {/* Custom Dropdown Menu */}
                                    <AnimatePresence>
                                        {isDriveSelectOpen && (
                                            <>
                                                <div
                                                    className="fixed inset-0 z-40"
                                                    onClick={() => setIsDriveSelectOpen(false)}
                                                />
                                                <motion.div
                                                    initial={{ opacity: 0, y: -10, scale: 0.95 }}
                                                    animate={{ opacity: 1, y: 0, scale: 1 }}
                                                    exit={{ opacity: 0, y: -10, scale: 0.95 }}
                                                    transition={{ duration: 0.15 }}
                                                    className="absolute top-full left-0 right-0 mt-3 p-2 bg-white/95 dark:bg-slate-800/95 backdrop-blur-xl rounded-3xl shadow-[0_10px_40px_-10px_rgba(0,0,0,0.2)] border border-black/5 dark:border-white/5 z-50 flex flex-col gap-1 overflow-hidden"
                                                >
                                                    {drives.map(d => (
                                                        <button
                                                            key={d.id}
                                                            onClick={() => {
                                                                setSelectedDrive(d.id);
                                                                setIsDriveSelectOpen(false);
                                                            }}
                                                            className={`flex items-center gap-3 px-4 py-3.5 rounded-2xl w-full text-left transition-colors ${selectedDrive === d.id
                                                                    ? 'bg-indigo-50 dark:bg-indigo-500/20 text-indigo-700 dark:text-indigo-300 font-bold'
                                                                    : 'hover:bg-slate-50 dark:hover:bg-slate-700/50 text-slate-700 dark:text-slate-300 font-medium'
                                                                }`}
                                                        >
                                                            <ServerStackIcon className={`w-5 h-5 ${selectedDrive === d.id ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-400'}`} />
                                                            <div className="flex flex-col">
                                                                <span>{d.name}</span>
                                                                <span className="text-xs font-normal opacity-70 uppercase tracking-wide">{d.type}</span>
                                                            </div>
                                                        </button>
                                                    ))}
                                                </motion.div>
                                            </>
                                        )}
                                    </AnimatePresence>
                                </div>
                            </div>

                            <div>
                                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3 ml-2 flex justify-between items-center">
                                    <span>Select Folder</span>
                                    <span className="text-indigo-500 font-mono lowercase tracking-normal bg-indigo-50 dark:bg-indigo-900/30 px-2.5 py-1 rounded-full">{targetPath}</span>
                                </label>
                                <div className="bg-slate-100/50 dark:bg-slate-800/50 rounded-3xl overflow-hidden h-44 flex flex-col relative shadow-inner">
                                    <div className="p-3 bg-black/5 dark:bg-slate-700/30 flex gap-2 items-center rounded-t-3xl border-b border-black/5 dark:border-white/5">
                                        <button
                                            onClick={() => handleNavigate('..')}
                                            disabled={targetPath === '/'}
                                            className="p-2 bg-white dark:bg-slate-600 shadow-sm hover:shadow dark:shadow-none hover:bg-slate-50 dark:hover:bg-slate-500 rounded-xl disabled:opacity-40 transition-all text-slate-600 dark:text-slate-300"
                                        >
                                            <ArrowUturnUpIcon className="w-4 h-4" />
                                        </button>
                                        <span className="text-xs font-medium text-slate-500 dark:text-slate-400 flex-1 truncate px-2">
                                            {targetPath}
                                        </span>
                                        <button
                                            onClick={() => setIsInputModalOpen(true)}
                                            className="p-2 bg-indigo-500 hover:bg-indigo-400 shadow-sm shadow-indigo-500/30 rounded-xl transition-all text-white"
                                            title="New Folder"
                                        >
                                            <FolderPlusIcon className="w-4 h-4" />
                                        </button>
                                    </div>
                                    <div className="flex-1 overflow-y-auto p-2 bg-transparent">
                                        {loadingFolders ? (
                                            <div className="flex items-center justify-center h-full">
                                                <div className="w-6 h-6 border-[3px] border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
                                            </div>
                                        ) : folders.length === 0 ? (
                                            <div className="flex items-center justify-center h-full text-xs font-medium text-slate-400/80">
                                                No subfolders
                                            </div>
                                        ) : (
                                            <div className="space-y-1.5">
                                                {folders.map((f, i) => (
                                                    <div
                                                        key={i}
                                                        onClick={() => handleNavigate(f.name)}
                                                        className="flex items-center gap-3 p-3 bg-white/70 dark:bg-slate-700/60 hover:bg-white dark:hover:bg-slate-600 rounded-2xl cursor-pointer transition-all shadow-sm border border-transparent hover:border-black/5 dark:hover:border-white/5"
                                                    >
                                                        <FolderIcon className="w-5 h-5 text-indigo-400 drop-shadow-sm" />
                                                        <span className="text-sm font-medium text-slate-700 dark:text-slate-200 truncate">{f.name}</span>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Floating Footer */}
                    <div className="p-6 pt-2 flex justify-between items-center gap-4">
                        <button
                            onClick={() => onClose()}
                            className="px-6 py-4 text-sm font-semibold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-full transition-colors flex-[1]"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleConfirm}
                            className="px-6 py-4 text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-500 rounded-full shadow-lg shadow-indigo-600/30 transition-all hover:scale-105 active:scale-95 flex-[2] truncate"
                        >
                            Upload • {(totalSize / 1024 / 1024).toFixed(1)} MB
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
