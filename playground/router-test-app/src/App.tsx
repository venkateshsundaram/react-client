import React from 'react';
import { Routes, Route, Link } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import './App.css';

export default function App() {
  return (
    <div className="app-container">
      <nav style={{ padding: '1rem', borderBottom: '1px solid #ccc', marginBottom: '1rem' }}>
        <Link to="/" style={{ marginRight: '1rem' }}>Home</Link>
        <Link to="/dashboard">Dashboard</Link>
      </nav>

      <Routes>
        <Route path="/" element={
          <div style={{ padding: '2rem' }}>
            <h1>Welcome to React Client</h1>
            <p>Get started by editing <code>src/App.tsx</code></p>
          </div>
        } />
        <Route path="/dashboard" element={<Dashboard />} />
      </Routes>
    </div>
  );
}
