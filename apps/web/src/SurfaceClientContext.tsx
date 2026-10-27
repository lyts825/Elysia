/* 定义界面客户端与根元素的 React Context 及读取 Hook。 */
import { createContext, useContext, type RefObject } from 'react';
import { defaultSurfaceClient } from './api';

// 未注入入口上下文时使用默认客户端；根节点上下文用于将浮层限制在当前入口。
export const SurfaceClientContext = createContext(defaultSurfaceClient);
export const SurfaceRootContext = createContext<RefObject<HTMLDivElement | null> | null>(null);
export const useSurfaceClient = () => useContext(SurfaceClientContext);
export const useSurfaceRoot = () => useContext(SurfaceRootContext);
