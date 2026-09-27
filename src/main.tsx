import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// StrictMode intentionally runs effects twice in development, which causes
// useWebSocket to open 2 connections to the Durable Object. Both connections
// live in the DO's sockets Set, so every broadcast comes back twice → 2 events
// per button click. Remove StrictMode to keep a single WS connection.
createRoot(document.getElementById('root')!).render(<App />)
