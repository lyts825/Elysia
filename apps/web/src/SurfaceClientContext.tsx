/* 定义界面客户端与根元素的 React Context 及读取 Hook。 */
import { createContext, useContext, type RefObject } from 'react';
import { defaultSurfaceClient } from './api';

// 未注入入口上下文时使用默认客户端；根节点上下文用于将浮层限制在当前入口。
export const SurfaceClientContext = createContext(defaultSurfaceClient);
export const SurfaceRootContext = createContext<RefObject<HTMLDivElement | null> | null>(null);
/** 获取当前工作台永久绑定的客户端，异步回调应捕获此客户端而非再次读取全局入口。 */
export const useSurfaceClient = () => useContext(SurfaceClientContext);
/** 获取当前入口 DOM 根；portal、焦点和弹窗查询优先限定到该范围。 */
export const useSurfaceRoot = () => useContext(SurfaceRootContext);
