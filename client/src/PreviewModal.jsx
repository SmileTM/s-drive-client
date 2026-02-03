import React, { useState, useEffect } from 'react';
import { XMarkIcon, ArrowDownTrayIcon, DocumentIcon } from '@heroicons/react/24/outline';
import axios from 'axios';

const PreviewModal = ({ file, onClose, drive = 'local' }) => {
  const [content, setContent] = useState(null);
  const [loading, setLoading] = useState(false);

  const fileUrl = `/api/raw?path=${encodeURIComponent(file.path)}&drive=${drive}`;
  const fileType = file.type || '';
  const isImage = fileType.startsWith('image/');
  const isVideo = fileType.startsWith('video/');
  const isAudio = fileType.startsWith('audio/');
  const isPDF = fileType === 'application/pdf';
  const isText = fileType.startsWith('text/') || 
                 /\.(json|js|jsx|ts|tsx|py|md|css|html|xml|yml|yaml|ini|conf|sh|bash|zsh)$/i.test(file.name);

  useEffect(() => {
    if (isText) {
      setLoading(true);
      axios.get(fileUrl, { responseType: 'text' })
        .then(res => setContent(res.data))
        .catch(() => setContent('Error loading content'))
        .finally(() => setLoading(false));
    }
  }, [fileUrl, isText]);

  // Handle ESC key
  useEffect(() => {
    const handleEsc = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm p-4" onClick={onClose}>
      
      {/* Close Button */}
      <button 
        onClick={onClose}
        className="absolute top-4 right-4 p-2 bg-white/10 hover:bg-white/20 rounded-full text-white transition-colors z-50"
      >
        <XMarkIcon className="w-6 h-6" />
      </button>

      {/* Main Content Area */}
      <div 
        className="relative max-w-5xl max-h-[90vh] w-full flex flex-col items-center justify-center"
        onClick={e => e.stopPropagation()} // Prevent closing when clicking content
      >
        
        {/* Preview Renderers */}
        {isImage && (
          <img src={fileUrl} alt={file.name} className="max-w-full max-h-[85vh] object-contain rounded-lg shadow-2xl" />
        )}

        {isVideo && (
          <video src={fileUrl} controls autoPlay className="max-w-full max-h-[85vh] rounded-lg shadow-2xl bg-black" />
        )}

        {isAudio && (
          <div className="bg-white p-8 rounded-2xl shadow-2xl flex flex-col items-center gap-4 min-w-[300px]">
            <div className="w-24 h-24 bg-indigo-100 rounded-full flex items-center justify-center mb-2">
              <DocumentIcon className="w-12 h-12 text-indigo-500" />
            </div>
            <h3 className="font-medium text-slate-800 text-center truncate w-full px-2">{file.name}</h3>
            <audio src={fileUrl} controls className="w-full" autoPlay />
          </div>
        )}

        {isPDF && (
          <iframe src={fileUrl} className="w-full h-[85vh] bg-white rounded-lg shadow-2xl" title="PDF Preview" />
        )}

        {isText && (
          <div className="w-full h-[85vh] bg-white rounded-lg shadow-2xl overflow-auto p-4 font-mono text-sm text-slate-700 whitespace-pre-wrap">
            {loading ? 'Loading...' : content}
          </div>
        )}

        {/* Fallback for unsupported types */}
        {!isImage && !isVideo && !isAudio && !isPDF && !isText && (
          <div className="bg-white p-10 rounded-2xl shadow-2xl flex flex-col items-center gap-6">
            <DocumentIcon className="w-20 h-20 text-slate-300" />
            <div className="text-center">
              <p className="text-lg font-medium text-slate-700">No Preview Available</p>
              <p className="text-sm text-slate-400 mt-1">{file.name}</p>
            </div>
            <a 
              href={fileUrl} 
              download 
              className="flex items-center gap-2 bg-indigo-600 text-white px-6 py-2.5 rounded-full hover:bg-indigo-700 transition-colors font-medium"
            >
              <ArrowDownTrayIcon className="w-5 h-5" />
              Download File
            </a>
          </div>
        )}

        {/* Download Button (Overlay for supported types) */}
        {(isImage || isVideo || isAudio || isPDF || isText) && (
          <a 
            href={fileUrl} 
            download
            onClick={(e) => e.stopPropagation()}
            className="absolute bottom-4 right-4 bg-white/10 hover:bg-white/20 text-white p-3 rounded-full backdrop-blur-md transition-colors"
            title="Download"
          >
            <ArrowDownTrayIcon className="w-6 h-6" />
          </a>
        )}

      </div>
    </div>
  );
};

export default PreviewModal;
