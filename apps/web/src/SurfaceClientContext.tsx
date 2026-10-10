import { createContext, useContext, type RefObject } from 'react';
import { defaultSurfaceClient } from './api';

export const SurfaceClientContext = createContext(defaultSurfaceClient);
export const SurfaceRootContext = createContext<RefObject<HTMLDivElement | null> | null>(null);
export const useSurfaceClient = () => useContext(SurfaceClientContext);
export const useSurfaceRoot = () => useContext(SurfaceRootContext);
