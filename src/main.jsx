import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'
import { AuthProvider } from '@/lib/AuthContext'
import { TooltipProvider } from '@/components/ui/tooltip'

// Apply saved theme before first paint to avoid flash.
// AuthContext will re-apply after login using the server-side preference.
(function () {
  const saved = localStorage.getItem('cardoso-theme');
  if (saved === 'light') {
    document.documentElement.classList.remove('dark');
  } else {
    // Default to dark (no saved pref or 'dark')
    document.documentElement.classList.add('dark');
  }
})();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      <TooltipProvider delayDuration={300}>
      <App />
      </TooltipProvider>
    </AuthProvider>
  </React.StrictMode>
)