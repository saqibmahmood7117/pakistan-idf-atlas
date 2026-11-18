"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CircleMarker, Map as LeafletMap } from "leaflet";

type Outlet = { lat: number; lng: number };
const DEFAULT_OUTLET: Outlet = { lat: 34.64737, lng: 72.03598 };
const INITIAL_ZOOM = 13;

export default function WatershedOutletMap({ latitude, longitude, onSelect, isInCoverage, fallback }: {
  latitude: number | null;
  longitude: number | null;
  onSelect: (latitude: number, longitude: number) => void;
  isInCoverage: (latitude: number, longitude: number) => boolean;
  fallback: React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markerRef = useRef<CircleMarker | null>(null);
  const [ready, setReady] = useState(false);
  const [tileError, setTileError] = useState(false);
  const [showFallback, setShowFallback] = useState(false);
  const [error, setError] = useState("");
  const [googleLocation, setGoogleLocation] = useState<string | null>(null);
  const current = useRef({ latitude, longitude, onSelect, isInCoverage });

  useEffect(() => {
    current.current = { latitude, longitude, onSelect, isInCoverage };
    const marker = markerRef.current;
    const map = mapRef.current;
    if (!marker || !map) return;
    if (latitude === null || longitude === null) {
      marker.remove();
    } else {
      marker.setLatLng([latitude, longitude]);
      if (!map.hasLayer(marker)) marker.addTo(map);
    }
  }, [latitude, longitude, onSelect, isInCoverage]);

  const select = useCallback((point: Outlet) => {
    const { isInCoverage, onSelect } = current.current;
    if (!isInCoverage(point.lat, point.lng)) {
      setError("Choose an outlet within the Atlas coverage area.");
      return;
    }
    setError("");
    onSelect(point.lat, point.lng);
  }, []);

  useEffect(() => {
    if (showFallback || !containerRef.current) return;
    const container = containerRef.current;
    let active = true;
    let map: LeafletMap | undefined;
    let observer: ResizeObserver | undefined;

    void import("leaflet").then(L => {
      if (!active) return;
      const { latitude, longitude } = current.current;
      const start = latitude === null || longitude === null ? DEFAULT_OUTLET : { lat: latitude, lng: longitude };
      const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      map = L.map(container, {
        minZoom: 5,
        maxZoom: 19,
        zoomAnimation: !prefersReducedMotion,
        fadeAnimation: !prefersReducedMotion,
        inertia: !prefersReducedMotion,
        doubleClickZoom: false,
      }).setView(start, INITIAL_ZOOM);
      mapRef.current = map;
      const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      });
      tiles.on("tileerror", () => setTileError(true));
      tiles.on("tileload", () => setTileError(false));
      tiles.addTo(map);
      markerRef.current = L.circleMarker(start, {
        radius: 7,
        color: "#fff",
        weight: 3,
        fillColor: "#b4233a",
        fillOpacity: 1,
        interactive: false,
      });
      if (latitude !== null && longitude !== null) markerRef.current.addTo(map);
      map.on("click", event => select(event.latlng));
      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(() => map?.invalidateSize({ pan: false }));
        observer.observe(container);
      }
      setReady(true);
    }).catch(() => {
      if (!active) return;
      setError("The street map could not load. The district map can still be used to select an outlet.");
      setShowFallback(true);
    });

    return () => {
      active = false;
      observer?.disconnect();
      map?.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, [select, showFallback]);

  const hasOutlet = latitude !== null && longitude !== null;
  const coordinate = hasOutlet ? `${latitude.toFixed(6)},${longitude.toFixed(6)}` : `${DEFAULT_OUTLET.lat},${DEFAULT_OUTLET.lng}`;

  function centerOnOutlet() {
    if (!hasOutlet) return;
    mapRef.current?.panTo([latitude, longitude], {
      animate: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    });
  }

  return <section className="watershed-outlet-picker" aria-labelledby="watershed-outlet-picker-title">
    <div className="outlet-map-head">
      <div>
        <span>Watershed outlet</span>
        <strong id="watershed-outlet-picker-title">Select the point where water leaves the catchment</strong>
      </div>
      <output aria-live="polite">{hasOutlet ? coordinate : "No outlet selected"}</output>
    </div>
    <div className="outlet-picker-toolbar" role="group" aria-label="Outlet map actions">
      {!showFallback && <button type="button" onClick={centerOnOutlet} disabled={!ready || !hasOutlet}>Centre on outlet</button>}
      {!showFallback && <button type="button" disabled={!ready} onClick={() => {
        const center = mapRef.current?.getCenter();
        if (center) select(center);
      }}>Use map centre</button>}
      <button type="button" onClick={() => {
        setReady(false);
        setTileError(false);
        setError("");
        setShowFallback(!showFallback);
      }}>{showFallback ? "Use street map" : "Use district map"}</button>
    </div>
    {showFallback ? fallback : <>
      <div className="outlet-street-map-wrap">
        <div ref={containerRef} className="outlet-street-map" role="region" aria-label="Interactive outlet map. Drag to pan and use the plus and minus keys to zoom." />
        {ready ? <span className="outlet-map-crosshair" aria-hidden="true" /> : <p className="outlet-map-loading" role="status">Loading street map…</p>}
      </div>
      <p className="outlet-picker-help">Drag to pan. Scroll, pinch or use + and − to zoom. Click or tap to place the outlet marker.</p>
      {tileError && <p className="outlet-picker-help" role="status">Some street map tiles are unavailable. You can switch to the district map above.</p>}
    </>}
    {error && <p className="outlet-picker-help" role="status">{error}</p>}
    <details className="outlet-google-reference" onToggle={event => {
      if (event.currentTarget.open && googleLocation === null) setGoogleLocation(coordinate);
    }}>
      <summary>Browse in Google Maps</summary>
      {googleLocation && <>
        <div className="outlet-picker-toolbar">
          <button type="button" onClick={() => setGoogleLocation(coordinate)}>Centre Google Maps on outlet</button>
          <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(coordinate)}`} target="_blank" rel="noreferrer">Open in Google Maps ↗</a>
        </div>
        <iframe src={`https://maps.google.com/maps?q=${encodeURIComponent(googleLocation)}&z=${INITIAL_ZOOM}&output=embed`}
          title="Google Maps reference for the selected outlet" loading="lazy" referrerPolicy="no-referrer-when-downgrade" />
        <p className="outlet-picker-help">Use the outlet map above or the coordinate fields below to set the point for MGHydro.</p>
      </>}
    </details>
  </section>;
}
