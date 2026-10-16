/*
 * When you play an agent yourself, the server hands this browser your seat's key: it's what lets you
 * move (and keeps anyone else, the agent included, from moving for you). Kept per game in localStorage.
 */

const key = (gameId: string) => `agent-chess:seat:${gameId}`;

export const saveSeat = (gameId: string, seatKey: string) => localStorage.setItem(key(gameId), seatKey);
export const seatKey = (gameId: string) => localStorage.getItem(key(gameId));

const NAME = "agent-chess:name";
export const savedName = () => localStorage.getItem(NAME) ?? "";
export const saveName = (name: string) => localStorage.setItem(NAME, name);
