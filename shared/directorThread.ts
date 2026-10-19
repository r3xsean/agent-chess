export interface DirectorThreadState {
  available: boolean;
  threadUrl?: string;
  status: "none" | "opening" | "ready" | "working" | "narrating" | "failed";
  error?: string;
  revision: string;
}
export interface VideoContext { time: number; ply?: number; format: "landscape" | "portrait" }
