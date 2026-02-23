import React, { useState, useEffect, useRef } from 'react';
import { XMarkIcon, ArrowDownTrayIcon, DocumentIcon, ChevronLeftIcon, ChevronRightIcon, PlayIcon, PauseIcon, ArrowsPointingOutIcon, ArrowsPointingInIcon } from '@heroicons/react/24/outline';
import heic2any from 'heic2any';
import clsx from 'clsx';
import { Document, Page, pdfjs } from 'react-pdf';
import { TransformWrapper, TransformComponent } from "react-zoom-pan-pinch";
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { motion } from 'framer-motion';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import api from './api';
import { translations } from './i18n';

// Configure PDF Worker
// Use local worker file from public/ directory
pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.js';

const formatTime = (seconds) => {
  if (!seconds || isNaN(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

const CustomAudioPlayer = ({ url, autoPlay = false }) => {
  const audioRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(autoPlay);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const safePlay = (media) => {
    if (!media) return;
    const promise = media.play();
    if (promise && typeof promise.catch === 'function') {
      promise.catch((e) => {
        console.warn('[Preview] Audio play() failed:', e);
        setIsPlaying(false);
      });
    }
  };

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    if (autoPlay) {
      safePlay(audio);
    }

    const updateTime = () => setCurrentTime(audio.currentTime);
    const updateDuration = () => setDuration(audio.duration);
    const onEnded = () => setIsPlaying(false);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);

    audio.addEventListener('timeupdate', updateTime);
    audio.addEventListener('loadedmetadata', updateDuration);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);

    return () => {
      audio.removeEventListener('timeupdate', updateTime);
      audio.removeEventListener('loadedmetadata', updateDuration);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
    };
  }, [url, autoPlay]);

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      safePlay(audioRef.current);
    }
  };

  const handleSeek = (e) => {
    const time = parseFloat(e.target.value);
    if (audioRef.current) {
      audioRef.current.currentTime = time;
      setCurrentTime(time);
    }
  };

  return (
    <div className="w-full flex flex-col gap-2 mt-2">
      <audio ref={audioRef} src={url} className="hidden" />

      {/* Controls Row */}
      <div className="flex items-center gap-4">
        <button
          onClick={(e) => { e.stopPropagation(); togglePlay(); }}
          className="p-3 bg-indigo-500 rounded-full text-white hover:bg-indigo-600 transition-colors shadow-md flex-shrink-0"
        >
          {isPlaying ? <PauseIcon className="w-6 h-6" /> : <PlayIcon className="w-6 h-6" />}
        </button>

        {/* Progress Bar (Line 1) */}
        <div className="flex-1 flex flex-col justify-center gap-1">
          <input
            type="range"
            min="0"
            max={duration || 0}
            value={currentTime}
            onChange={handleSeek}
            onClick={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            onTouchMove={(e) => e.stopPropagation()}
            onTouchEnd={(e) => e.stopPropagation()}
            className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-indigo-500 hover:accent-indigo-600"
          />

          {/* Time Display (Line 2) */}
          <div className="flex justify-between text-xs text-slate-500 font-medium px-0.5">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

const CustomVideoPlayer = ({ url, autoPlay = false, isFullscreen = false, toggleFullscreen }) => {
  const videoRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(autoPlay);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekTime, setSeekTime] = useState(0);
  const containerRef = useRef(null);

  useEffect(() => {
    console.log('[Preview] CustomVideoPlayer MOUNTED. URL:', url);
    return () => console.log('[Preview] CustomVideoPlayer UNMOUNTED. URL:', url);
  }, [url]);

  const safePlay = (media) => {
    if (!media) return;
    const promise = media.play();
    if (promise && typeof promise.catch === 'function') {
      promise.catch((e) => {
        console.warn('[Preview] Video play() failed:', e);
        setIsPlaying(false);
      });
    }
  };

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && isFullscreen) {
        console.log('[Preview] CustomVideoPlayer Escape intercepted (preventing modal close)');
        e.stopPropagation();
        if (toggleFullscreen) toggleFullscreen();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isFullscreen, toggleFullscreen]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const updateTime = () => {
      if (!isSeeking) setCurrentTime(video.currentTime);
    };
    const updateDuration = () => setDuration(video.duration);
    const onEnded = () => setIsPlaying(false);

    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('timeupdate', updateTime);
    video.addEventListener('loadedmetadata', updateDuration);
    video.addEventListener('ended', onEnded);

    return () => {
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('timeupdate', updateTime);
      video.removeEventListener('loadedmetadata', updateDuration);
      video.removeEventListener('ended', onEnded);
    };
  }, [url, isSeeking]);

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (isPlaying) videoRef.current.pause();
    else safePlay(videoRef.current);
  };

  const handleSeek = (e) => {
    const time = parseFloat(e.target.value);
    setSeekTime(time);
    setCurrentTime(time);
  };

  const beginSeek = () => {
    if (!videoRef.current) return;
    setIsSeeking(true);
    setSeekTime(videoRef.current.currentTime || 0);
  };

  const commitSeek = () => {
    if (!videoRef.current) return;
    const target = Number.isFinite(seekTime) ? seekTime : 0;
    if (typeof videoRef.current.fastSeek === 'function') {
      videoRef.current.fastSeek(target);
    } else {
      videoRef.current.currentTime = target;
    }
    setCurrentTime(target);
    setIsSeeking(false);
  };

  return (
    <div ref={containerRef} className="flex flex-col w-full h-full overflow-hidden">
      <div className="relative w-full h-full flex flex-col items-center justify-center bg-transparent" onClick={(e) => { e.stopPropagation(); togglePlay(); }}>
        <video
          ref={videoRef}
          src={url}
          autoPlay={autoPlay}
          preload="metadata"
          playsInline
          style={{ transform: "translateZ(0)" }}
          className="w-full h-full object-contain max-h-full"
        />
        {!isPlaying && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/20 pointer-events-none">
            <div className="p-4 bg-white/20 backdrop-blur-md rounded-full text-white">
              <PlayIcon className="w-12 h-12" />
            </div>
          </div>
        )}
      </div>

      <div className="p-4 flex items-center gap-4 text-white">
        <button
          onClick={(e) => { e.stopPropagation(); togglePlay(); }}
          className="p-2 hover:bg-white/10 rounded-full transition-colors flex-shrink-0"
        >
          {isPlaying ? <PauseIcon className="w-6 h-6" /> : <PlayIcon className="w-6 h-6" />}
        </button>

        <div className="flex-1 flex flex-col justify-center gap-1.5">
          <input
            type="range"
            min="0"
            max={duration || 0}
            value={isSeeking ? seekTime : currentTime}
            onChange={handleSeek}
            onMouseDown={beginSeek}
            onTouchStart={(e) => { e.stopPropagation(); beginSeek(); }}
            onMouseUp={commitSeek}
            onTouchEnd={(e) => { e.stopPropagation(); commitSeek(); }}
            onClick={(e) => e.stopPropagation()}
            onTouchMove={(e) => e.stopPropagation()}
            className="w-full h-1 bg-white/20 rounded-lg appearance-none cursor-pointer accent-indigo-500 hover:accent-indigo-400"
          />

          <div className="flex justify-between text-[10px] text-white/60 font-medium px-0.5">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>

        <button
          onClick={(e) => {
            e.stopPropagation();
            toggleFullscreen();
          }}
          className="p-2 hover:bg-white/10 rounded-full transition-colors flex-shrink-0"
          title={isFullscreen ? "退出全屏" : "全屏"}
        >
          {isFullscreen ? <ArrowsPointingInIcon className="w-6 h-6" /> : <ArrowsPointingOutIcon className="w-6 h-6" />}
        </button>
      </div>
    </div>
  );
};

const PreviewModal = ({ file, onClose, drive = 'local', onNext, onPrev, hasNext, hasPrev, lang = 'zh', onDownload, onFullscreenChange }) => {
  const triggerClose = (source) => {
    // console.warn(`[PreviewModal] triggerClose CALLED from source: ${source}`);
    onClose();
  };

  const t = translations[lang];
  const [content, setContent] = useState(null);
  const [loading, setLoading] = useState(false);
  const [url, setUrl] = useState('');
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Sync fullscreen state back to parent if callback provided
  useEffect(() => {
    if (onFullscreenChange) {
      onFullscreenChange(isFullscreen);
    }
  }, [isFullscreen, onFullscreenChange]);

  const touchStart = useRef(null);
  const touchEnd = useRef(null);
  const minSwipeDistance = 50;
  const isZoomed = useRef(false);

  const [numPages, setNumPages] = useState(null);
  const [pdfScale, setPdfScale] = useState(1.0);

  const fileType = file.type || '';
  const isHeic = fileType === 'image/heic' || fileType === 'image/heif' || /\.(heic|heif)$/i.test(file.name);
  const isImage = (fileType.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i.test(file.name)) && !isHeic;
  const isVideo = fileType.startsWith('video/') || /\.(mp4|webm|ogg|mov|avi|mkv|3gp)$/i.test(file.name);
  const isAudio = fileType.startsWith('audio/') || /\.(mp3|wav|aac|flac|m4a)$/i.test(file.name);
  const isPDF = fileType === 'application/pdf' || /\.pdf$/i.test(file.name);
  const isText = fileType.startsWith('text/') ||
    /\.(json|js|jsx|ts|tsx|py|md|css|html|xml|yml|yaml|ini|conf|sh|bash|zsh)$/i.test(file.name);

  const isNative = Capacitor.isNativePlatform();

  useEffect(() => {
    // console.log(`[PreviewModal] MOUNTED for file: ${file.name}`);
    return () => { }; // console.log(`[PreviewModal] UNMOUNTED for file: ${file.name}`);
  }, [file.name]);

  useEffect(() => {
    const load = async () => {
      isZoomed.current = false;
      setUrl('');
      setContent(null);

      if (isHeic) {
        setLoading(true);
        if (!isNative) {
          const previewUrl = `/api/preview?path=${encodeURIComponent(file.path)}&drive=${drive}`;
          setUrl(previewUrl);
          setLoading(false);
          return;
        }

        try {
          const blob = await api.getFileBlob(file.path, drive);
          const convertedBlob = await heic2any({
            blob,
            toType: "image/jpeg",
            quality: 0.8
          });
          const resultBlob = Array.isArray(convertedBlob) ? convertedBlob[0] : convertedBlob;
          setUrl(URL.createObjectURL(resultBlob));
        } catch (e) {
          console.error("HEIC conversion failed", e);
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
          setContent(t.errorLoading);
        } finally {
          setLoading(false);
        }
      }
    };
    load();

    return () => {
      if (isHeic && url && isNative) {
        URL.revokeObjectURL(url);
      }
    }
  }, [file.path, drive, isText, isHeic]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (isFullscreen) {
          console.log('[PreviewModal] Escape key pressed directly on Modal (exiting fullscreen)');
          setIsFullscreen(false);
        } else {
          console.log('[PreviewModal] Escape key pressed directly on Modal (closing)');
          triggerClose('Escape Key');
        }
      }
      if (e.key === 'ArrowRight' && onNext) onNext();
      if (e.key === 'ArrowLeft' && onPrev) onPrev();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, onNext, onPrev, isFullscreen]);

  const onTouchStart = (e) => {
    e.stopPropagation();
    if (isZoomed.current) return;
    touchEnd.current = null;
    touchStart.current = e.targetTouches[0].clientX;
  };

  const onTouchMove = (e) => {
    e.stopPropagation();
    if (isZoomed.current) return;
    touchEnd.current = e.targetTouches[0].clientX;
  };

  const onTouchEnd = () => {
    if (isZoomed.current) return;
    if (!touchStart.current || !touchEnd.current) return;
    const distance = touchStart.current - touchEnd.current;
    const isLeftSwipe = distance > minSwipeDistance;
    const isRightSwipe = distance < -minSwipeDistance;

    if (isLeftSwipe && onNext) onNext();
    if (isRightSwipe && onPrev) onPrev();
  };

  function onDocumentLoadSuccess({ numPages }) {
    setNumPages(numPages);
  }

  const handleDownload = async (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (onDownload) {
      onDownload(file);
      return;
    }

    if (!isNative) {
      if (!url) return;
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      a.click();
      return;
    }

    try {
      let blob;
      if (url && url.startsWith('blob:')) {
        const response = await fetch(url);
        blob = await response.blob();
      } else {
        blob = await api.getFileBlob(file.path, drive);
      }

      const reader = new FileReader();
      reader.readAsDataURL(blob);
      reader.onloadend = async () => {
        const base64data = reader.result;
        try {
          await Filesystem.writeFile({
            path: `Download/${file.name}`,
            data: base64data,
            directory: Directory.ExternalStorage,
            recursive: true
          });
          alert(t.downloadSuccess);
        } catch (err) {
          console.error(err);
          alert(t.downloadFailed);
        }
      };
    } catch (err) {
      console.error(err);
      alert(t.downloadFailed);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className={clsx(
        "fixed inset-0 z-[100] flex items-center justify-center backdrop-blur-2xl transition-all",
        isFullscreen ? "bg-black p-0" : "bg-black/40 p-4"
      )}
      onClick={(e) => {
        e.stopPropagation();
        if (isFullscreen) return;
        // console.log('[PreviewModal] Background Backdrop Clicked');
        triggerClose('Background Backdrop');
      }}
      onTouchStart={(e) => {
        e.stopPropagation();
        onTouchStart(e);
      }}
      onTouchMove={(e) => {
        e.stopPropagation();
        onTouchMove(e);
      }}
      onTouchEnd={(e) => {
        e.stopPropagation();
        onTouchEnd();
      }}
    >

      {hasPrev && !isFullscreen && (
        <button
          onClick={(e) => { e.stopPropagation(); onPrev(); }}
          className="absolute left-4 top-1/2 -translate-y-1/2 p-3 bg-white/10 hover:bg-white/20 rounded-full text-white transition-all hidden md:flex z-50"
        >
          <ChevronLeftIcon className="w-8 h-8" />
        </button>
      )}

      {hasNext && !isFullscreen && (
        <button
          onClick={(e) => { e.stopPropagation(); onNext(); }}
          className="absolute right-4 top-1/2 -translate-y-1/2 p-3 bg-white/10 hover:bg-white/20 rounded-full text-white transition-all hidden md:flex z-50"
        >
          <ChevronRightIcon className="w-8 h-8" />
        </button>
      )}

      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ type: "spring", stiffness: 300, damping: 30 }}
        className={clsx(
          "relative flex flex-col items-center justify-center transition-all",
          isFullscreen ? "w-full h-full max-w-none max-h-none p-0" : "w-full max-w-5xl max-h-[85vh] pb-16"
        )}
        onClick={e => e.stopPropagation()}
      >

        {(isImage || isHeic) && url && (
          <div
            className="w-full h-full flex items-center justify-center overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <TransformWrapper
              initialScale={1}
              minScale={1}
              maxScale={8}
              centerOnInit={true}
              onTransformed={(ref) => {
                isZoomed.current = ref.state.scale > 1.01;
              }}
            >
              <TransformComponent wrapperStyle={{ width: "100%", height: "100%" }}>
                <img
                  src={url}
                  alt={file.name}
                  className="max-w-[90vw] max-h-[80vh] object-contain rounded-lg shadow-2xl"
                />
              </TransformComponent>
            </TransformWrapper>
          </div>
        )}

        {isVideo && url && (
          <div className={clsx(
            "w-full h-full flex items-center justify-center overflow-hidden transition-all",
            isFullscreen ? "bg-black rounded-none" : "bg-black/80 backdrop-blur-xl rounded-2xl shadow-2xl"
          )}>
            <CustomVideoPlayer
              key={url}
              url={url}
              autoPlay={true}
              isFullscreen={isFullscreen}
              toggleFullscreen={() => {
                console.log("[Preview] calling lifted toggleFullscreen");
                setIsFullscreen(prev => !prev)
              }}
            />
          </div>
        )}

        {isAudio && url && (
          <div className="bg-white/90 backdrop-blur-xl p-8 rounded-[32px] shadow-2xl flex flex-col items-center gap-4 min-w-[300px] w-full max-w-md border border-white/20">
            <div className="w-24 h-24 bg-indigo-100/50 rounded-full flex items-center justify-center mb-2">
              <DocumentIcon className="w-12 h-12 text-indigo-500" />
            </div>
            <h3 className="font-medium text-slate-800 text-center truncate w-full px-2">{file.name}</h3>
            <CustomAudioPlayer key={url} url={url} autoPlay={true} />
          </div>
        )}

        {isPDF && url && (
          <div className="relative w-full h-[80vh] flex flex-col items-center">
            <div className="flex-1 overflow-auto w-full flex flex-col items-center p-4 no-scrollbar">
              <Document
                file={url}
                onLoadSuccess={onDocumentLoadSuccess}
                onLoadError={(error) => console.error('[Preview] PDF Load Error:', error)}
                options={{
                  cMapUrl: `/cmaps/`,
                  cMapPacked: true,
                  standardFontDataUrl: `/standard_fonts/`,
                }}
                loading={
                  <div className="flex items-center justify-center p-8">
                    <div className="bg-white/80 backdrop-blur-xl rounded-2xl px-8 py-4 shadow-xl border border-white/20 text-slate-600 font-medium animate-pulse">
                      {t.loading}
                    </div>
                  </div>
                }
                error={
                  <div className="flex items-center justify-center p-8">
                    <div className="bg-white/80 backdrop-blur-xl rounded-2xl px-8 py-4 shadow-xl border border-white/20 text-red-500 font-medium">
                      {t.errorLoading}
                    </div>
                  </div>
                }
                className="flex flex-col gap-4"
              >
                {Array.from(new Array(numPages), (el, index) => (
                  <Page
                    key={`page_${index + 1}`}
                    pageNumber={index + 1}
                    scale={pdfScale}
                    width={window.innerWidth > 800 ? 800 : window.innerWidth - 60}
                    renderTextLayer={false}
                    renderAnnotationLayer={false}
                    className="bg-white shadow-sm"
                    loading={null}
                  />
                ))}
              </Document>
            </div>
          </div>
        )}

        {isText && (
          <div className="w-full h-[80vh] bg-white/90 backdrop-blur-xl rounded-[32px] shadow-2xl overflow-auto p-6 font-mono text-sm text-slate-700 whitespace-pre-wrap border border-white/20">
            {loading ? t.loading : content}
          </div>
        )}

        {!isImage && !isHeic && !isVideo && !isAudio && !isPDF && !isText && (
          <div className="glass-bg-default glass-blur p-10 rounded-[32px] shadow-2xl flex flex-col items-center gap-6 border border-white/20 max-w-sm">
            <div className="w-20 h-20 bg-white/50 rounded-2xl flex items-center justify-center shadow-inner text-slate-300">
              <DocumentIcon className="w-12 h-12" />
            </div>
            <div className="text-center">
              <p className="text-lg font-semibold text-slate-800">{t.noPreview}</p>
              <p className="text-sm text-slate-500 mt-1 break-all px-4">{file.name}</p>
            </div>
            {drive !== 'local' && (
              <button
                onClick={handleDownload}
                className="flex items-center gap-2 bg-indigo-500 text-white px-8 py-3 rounded-2xl hover:bg-indigo-600 transition-all font-medium shadow-lg shadow-indigo-200 active:scale-95 text-sm"
              >
                <ArrowDownTrayIcon className="w-5 h-5" />
                {t.download}
              </button>
            )}
          </div>
        )}
      </motion.div>

      {!isFullscreen && (
        <div
          className="fixed left-1/2 -translate-x-1/2 z-50 flex items-center transition-all gap-4"
          style={{ bottom: 'calc(2rem + env(safe-area-inset-bottom))' }}
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              console.log('[PreviewModal] Unified Close Button Clicked');
              triggerClose('Unified Close Button');
            }}
            className="flex items-center justify-center rounded-full bg-white/20 backdrop-blur-xl border border-white/20 shadow-xl text-white transition-all active:scale-95 p-3.5 hover:bg-white/30"
            title={t.close}
          >
            <XMarkIcon className="w-6 h-6" />
          </button>

          {drive !== 'local' && (
            <button
              onClick={handleDownload}
              className="flex items-center justify-center rounded-full bg-white/20 backdrop-blur-xl border border-white/20 shadow-xl text-white transition-all active:scale-95 p-3.5 hover:bg-white/30"
              title={t.download}
            >
              <ArrowDownTrayIcon className="w-6 h-6" />
            </button>
          )}
        </div>
      )}

    </motion.div>
  );
};

export default PreviewModal;
