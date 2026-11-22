// Headless fork clients (Discord bot) own their socket instead of going through the
// connection supervisor, so they need the session factory upstream keeps internal.
export { RpcSessionFactory, layer as rpcSessionFactoryLayer, type RpcSession } from "./session.ts";
export { applyServerConfigProjection } from "../state/serverConfigProjection.ts";
