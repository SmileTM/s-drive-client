import React, { useState, useEffect } from 'react';
import { XMarkIcon, ArrowDownTrayIcon, DocumentIcon } from '@heroicons/react/24/outline';
import heic2any from 'heic2any';
import api from './api';

const PreviewModal = ({ file, onClose, drive = 'local' }) => {
  const [content, setContent] = useState(null);
  const [loading, setLoading] = useState(false);
  const [url, setUrl] = useState('');

  const fileType = file.type || '';
  const isHeic = fileType === 'image/heic' || fileType === 'image/heif' || /\.(heic|heif)$/i.test(file.name);
  const isImage = (fileType.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i.test(file.name)) && !isHeic;
  const isVideo = fileType.startsWith('video/') || /\.(mp4|webm|ogg|mov|avi|mkv|3gp)$/i.test(file.name);
  const isAudio = fileType.startsWith('audio/') || /\.(mp3|wav|aac|flac|m4a)$/i.test(file.name);
  const isPDF = fileType === 'application/pdf' || /\.pdf$/i.test(file.name);
  const isText = fileType.startsWith('text/') || 
                 /\.(json|js|jsx|ts|tsx|py|md|css|html|xml|yml|yaml|ini|conf|sh|bash|zsh)$/i.test(file.name);

  useEffect(() => {
    const load = async () => {
        if (isHeic) {
            setLoading(true);
            try {
                // For HEIC, we need the actual blob to convert
                const blob = await api.getFileBlob(file.path, drive);
                const convertedBlob = await heic2any({
                    blob,
                    toType: "image/jpeg",
                    quality: 0.8
                });
                // Handle case where heic2any returns an array
                const resultBlob = Array.isArray(convertedBlob) ? convertedBlob[0] : convertedBlob;
                setUrl(URL.createObjectURL(resultBlob));
            } catch (e) {
                console.error("HEIC conversion failed", e);
                // Fallback to raw URL if conversion fails
                const res = await api.getFileUrl(file.path, drive);
                setUrl(res);
            } finally {
                setLoading(false);
            }
            return;
        }

        const res = await api.getFileUrl(file.path, drive);
        setUrl(res);
        
        if (isText) {
            setLoading(true);
            try {
                const text = await api.readFileText(file.path, drive);
                setContent(text);
            } catch (e) {
                setContent('Error loading content');
            } finally {
                setLoading(false);
            }
        }
    };
    load();

    return () => {
        if (isHeic && url) {
            URL.revokeObjectURL(url);
        }
    }
  }, [file.path, drive, isText, isHeic]);

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
        {(isImage || isHeic) && url && (
          <img src={url} alt={file.name} className="max-w-full max-h-[85vh] object-contain rounded-lg shadow-2xl" />
        )}

        {isVideo && url && (
          <video src={url} controls autoPlay className="max-w-full max-h-[85vh] rounded-lg shadow-2xl bg-black" />
        )}

        {isAudio && url && (
          <div className="bg-white p-8 rounded-2xl shadow-2xl flex flex-col items-center gap-4 min-w-[300px]">
            <div className="w-24 h-24 bg-indigo-100 rounded-full flex items-center justify-center mb-2">
              <DocumentIcon className="w-12 h-12 text-indigo-500" />
            </div>
            <h3 className="font-medium text-slate-800 text-center truncate w-full px-2">{file.name}</h3>
            <audio src={url} controls className="w-full" autoPlay />
          </div>
        )}

        {isPDF && url && (
          <iframe src={url} className="w-full h-[85vh] bg-white rounded-lg shadow-2xl" title="PDF Preview" />
        )}

        {isText && (
          <div className="w-full h-[85vh] bg-white rounded-lg shadow-2xl overflow-auto p-4 font-mono text-sm text-slate-700 whitespace-pre-wrap">
            {loading ? 'Loading...' : content}
          </div>
        )}

        {/* Fallback for unsupported types */}
        {!isImage && !isHeic && !isVideo && !isAudio && !isPDF && !isText && (
          <div className="bg-white p-10 rounded-2xl shadow-2xl flex flex-col items-center gap-6">
            <DocumentIcon className="w-20 h-20 text-slate-300" />
            <div className="text-center">
              <p className="text-lg font-medium text-slate-700">No Preview Available</p>
              <p className="text-sm text-slate-400 mt-1">{file.name}</p>
            </div>
            {url && (
            <a 
              href={url} 
              download={file.name}
              className="flex items-center gap-2 bg-indigo-600 text-white px-6 py-2.5 rounded-full hover:bg-indigo-700 transition-colors font-medium"
            >
              <ArrowDownTrayIcon className="w-5 h-5" />
              Download File
            </a>
            )}
          </div>
        )}

        {/* Download Button (Overlay for supported types) */}
        {(isImage || isHeic || isVideo || isAudio || isPDF || isText) && url && (
          <a 
            href={url} 
            download={file.name}
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
