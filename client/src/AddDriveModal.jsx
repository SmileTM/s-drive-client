import React, { useState } from 'react';
import api from './api';
import clsx from 'clsx';
import { motion } from 'framer-motion';
// import { XMarkIcon, ServerStackIcon } from '@heroicons/react/24/outline';
import { translations } from './i18n';

const AddDriveModal = ({ onClose, onAdded, lang = 'en' }) => {
  const t = translations[lang];
  const [loading, setLoading] = useState(false);
  const [testStatus, setTestStatus] = useState({ type: 'idle', msg: '' });
  const [protocol, setProtocol] = useState('webdav'); // 'webdav' or 'smb'
  const [formData, setFormData] = useState({
    name: '',
    url: '',
    username: '',
    password: '',
    // SMB specific
    address: '',
    share: '',
    domain: ''
  });

  const handleTest = async () => {
    if (protocol === 'webdav' && !formData.url) {
      setTestStatus({ type: 'error', msg: t.urlRequired });
      return;
    }
    if (protocol === 'smb' && (!formData.address || !formData.share)) {
      setTestStatus({ type: 'error', msg: t.hostShareRequired });
      return;
    }

    setTestStatus({ type: 'testing', msg: t.testing });
    try {
      const payload = protocol === 'webdav' 
        ? { type: 'webdav', url: formData.url, username: formData.username, password: formData.password }
        : { type: 'smb', address: formData.address, share: formData.share, domain: formData.domain, username: formData.username, password: formData.password };
      
      await api.testConnection(payload);
      setTestStatus({ type: 'success', msg: t.connectionSuccess });
    } catch (err) {
      setTestStatus({ type: 'error', msg: t.connectionFailed });
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (loading) return; 
    setLoading(true);
    setTestStatus({ type: 'testing', msg: t.testing });
    
    try {
      if (!formData.name) {
        alert(t.nameRequired);
        setLoading(false);
        return;
      }

      const payload = protocol === 'webdav' 
        ? { 
            type: 'webdav', 
            name: formData.name,
            url: formData.url, 
            username: formData.username, 
            password: formData.password,
            quota: null
          }
        : { 
            type: 'smb',
            name: formData.name, 
            address: formData.address, 
            share: formData.share, 
            domain: formData.domain, 
            username: formData.username, 
            password: formData.password,
            quota: null
          };

      // Step 1: Verify Connection First
      try {
        await api.testConnection(payload);
      } catch (testErr) {
        setTestStatus({ type: 'error', msg: t.connectionFailed });
        // Don't proceed if test fails
        setLoading(false);
        return; 
      }

      // Step 2: Save Drive
      const newDrive = await api.addDrive(payload);
      onAdded(newDrive); 
      onClose();
    } catch (err) {
      console.error(err);
      const msg = err.response?.data?.error || err.message || JSON.stringify(err);
      if (err.response?.status === 409) {
        if (msg.includes('Name')) {
          alert(t.nameTaken);
        } else {
          alert(t.driveAccountAdded);
        }
      } else if (msg.includes('Share Name Not Found')) {
          alert(t.shareNameNotFound);
      } else {
        alert(`${t.failedToAdd}: ${msg}`);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <motion.div 
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        transition={{ type: "spring", stiffness: 400, damping: 30 }}
        onClick={(e) => e.stopPropagation()}
        className="bg-white/90 backdrop-blur-2xl rounded-[32px] shadow-2xl w-full max-w-md overflow-hidden border border-white/20 p-6 flex flex-col gap-4"
      >
        
        {/* Header */}
        <div className="flex items-center justify-between pb-2">
          <h2 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
            <span className="text-2xl">☁️</span>
            {t.modalTitle}
          </h2>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-slate-100/50 text-slate-400 hover:text-slate-600 transition-colors">
            <span>✕</span>
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          
          {/* Protocol Selector */}
          <div className="flex bg-slate-100 p-1 rounded-2xl">
            <button
              type="button"
              onClick={() => setProtocol('webdav')}
              className={clsx(
                "flex-1 py-2 text-xs font-medium rounded-xl transition-all",
                protocol === 'webdav' ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500 hover:text-slate-700"
              )}
            >
              WebDAV
            </button>
            <button
              type="button"
              onClick={() => setProtocol('smb')}
              className={clsx(
                "flex-1 py-2 text-xs font-medium rounded-xl transition-all",
                protocol === 'smb' ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500 hover:text-slate-700"
              )}
            >
              SMB / CIFS
            </button>
          </div>

          <div>
            <label htmlFor="drive-name" className="block text-xs font-medium text-slate-500 mb-1 ml-1">{t.displayName}</label>
            <input 
              id="drive-name"
              name="name"
              type="text" 
              placeholder="e.g. My Drive"
              className="w-full px-4 py-3 bg-slate-50/50 border border-slate-200 rounded-2xl focus:border-indigo-500 focus:ring-2 focus:ring-indigo-50 outline-none transition-all text-sm text-slate-700"
              value={formData.name}
              onChange={e => setFormData({...formData, name: e.target.value})}
            />
          </div>

          {protocol === 'webdav' ? (
            <div>
              <label htmlFor="drive-url" className="block text-xs font-medium text-slate-500 mb-1 ml-1">{t.webdavUrl}</label>
              <input 
                id="drive-url"
                name="url"
                type="url" 
                placeholder="https://dav.example.com/webdav/"
                className="w-full px-4 py-3 bg-slate-50/50 border border-slate-200 rounded-2xl focus:border-indigo-500 focus:ring-2 focus:ring-indigo-50 outline-none transition-all text-sm text-slate-700"
                value={formData.url}
                onChange={e => setFormData({...formData, url: e.target.value})}
              />
              <p className="mt-1.5 text-[10px] text-slate-400 ml-1">
                {t.tipRoot}
              </p>
            </div>
          ) : (
            <div className="space-y-4">
               <div className="grid grid-cols-3 gap-4">
                  <div className="col-span-2">
                    <label htmlFor="smb-address" className="block text-xs font-medium text-slate-500 mb-1 ml-1">{t.host}</label>
                    <input 
                      id="smb-address"
                      name="address"
                      type="text" 
                      placeholder="192.168.1.10"
                      className="w-full px-4 py-3 bg-slate-50/50 border border-slate-200 rounded-2xl focus:border-indigo-500 focus:ring-2 focus:ring-indigo-50 outline-none transition-all text-sm text-slate-700"
                      value={formData.address}
                      onChange={e => setFormData({...formData, address: e.target.value})}
                    />
                  </div>
                  <div className="col-span-1">
                    <label htmlFor="smb-share" className="block text-xs font-medium text-slate-500 mb-1 ml-1">{t.shareName}</label>
                    <input 
                      id="smb-share"
                      name="share"
                      type="text" 
                      placeholder="Public"
                      className="w-full px-4 py-3 bg-slate-50/50 border border-slate-200 rounded-2xl focus:border-indigo-500 focus:ring-2 focus:ring-indigo-50 outline-none transition-all text-sm text-slate-700"
                      value={formData.share}
                      onChange={e => setFormData({...formData, share: e.target.value})}
                    />
                  </div>
               </div>
               <div>
                  <label htmlFor="smb-domain" className="block text-xs font-medium text-slate-500 mb-1 ml-1">{t.domain}</label>
                  <input 
                    id="smb-domain"
                    name="domain"
                    type="text" 
                    placeholder="WORKGROUP"
                    className="w-full px-4 py-3 bg-slate-50/50 border border-slate-200 rounded-2xl focus:border-indigo-500 focus:ring-2 focus:ring-indigo-50 outline-none transition-all text-sm text-slate-700"
                    value={formData.domain}
                    onChange={e => setFormData({...formData, domain: e.target.value})}
                  />
               </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="drive-username" className="block text-xs font-medium text-slate-500 mb-1 ml-1">{t.username}</label>
              <input 
                id="drive-username"
                name="username"
                type="text" 
                autoComplete="username"
                className="w-full px-4 py-3 bg-slate-50/50 border border-slate-200 rounded-2xl focus:border-indigo-500 focus:ring-2 focus:ring-indigo-50 outline-none transition-all text-sm text-slate-700"
                value={formData.username}
                onChange={e => setFormData({...formData, username: e.target.value})}
              />
            </div>
            <div>
              <label htmlFor="drive-password" className="block text-xs font-medium text-slate-500 mb-1 ml-1">{t.password}</label>
              <input 
                id="drive-password"
                name="password"
                type="password" 
                autoComplete="current-password"
                className="w-full px-4 py-3 bg-slate-50/50 border border-slate-200 rounded-2xl focus:border-indigo-500 focus:ring-2 focus:ring-indigo-50 outline-none transition-all text-sm text-slate-700"
                value={formData.password}
                onChange={e => setFormData({...formData, password: e.target.value})}
              />
            </div>
          </div>

          {/* Status Message */}
          {testStatus.type !== 'idle' && (
            <div className={clsx(
              "text-xs px-4 py-3 rounded-2xl text-center font-medium",
              testStatus.type === 'success' ? "bg-green-50 text-green-600 border border-green-100" : 
              testStatus.type === 'error' ? "bg-red-50 text-red-600 border border-red-100" : "bg-slate-50 text-slate-500 border border-slate-100"
            )}>
              {testStatus.msg}
            </div>
          )}

          <div className="pt-2 flex justify-end gap-3">
            <button 
              type="button" 
              onClick={handleTest}
              disabled={testStatus.type === 'testing'}
              className="mr-auto px-5 py-3 rounded-2xl text-sm font-medium border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors"
            >
              {t.testConnection}
            </button>

            <button 
              type="button" 
              onClick={onClose}
              className="px-5 py-3 rounded-2xl text-sm font-medium border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-700 transition-colors"
            >
              {t.cancel}
            </button>
            <button 
              type="submit" 
              disabled={loading}
              className="px-6 py-3 rounded-2xl text-sm font-medium bg-indigo-500 text-white hover:bg-indigo-600 active:scale-95 transition-all shadow-lg shadow-indigo-200 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? t.adding : t.connectDrive}
            </button>
          </div>

        </form>
      </motion.div>
    </motion.div>
  );
};
export default AddDriveModal;