import { useState } from 'react';
import { MapView } from './map/MapView.js';
import { Sidebar } from './ui/Sidebar.js';

export function App() {
  const [cursor, setCursor] = useState('Flytta markören över kartan');
  return (
    <div className="app">
      <Sidebar />
      <div className="map-container">
        <MapView onCursor={setCursor} />
        <div className="statusbar">{cursor}</div>
      </div>
    </div>
  );
}
