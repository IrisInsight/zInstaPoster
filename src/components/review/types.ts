export interface ReviewPost {
  id: string;
  status: string;
  title: string;
  caption: string;
  approvedBy: string | null;
  approvedAt: string | null;
  scheduledFor: string | null;
  igAccountId: string | null;
  failureReason: string | null;
}

export interface ReviewSlide {
  id: string;
  position: number;
  type: string;
  copy: Record<string, unknown>;
  altText: string;
  photoPrompt: string | null;
  photoUrl: string | null;
  renderedUrl: string | null;
  bytes: number | null;
  width: number;
  height: number;
}

export interface PhotoOption {
  id: string;
  url: string;
  prompt: string;
  provider: string;
  selected: boolean;
}

export interface WindowSuggestion {
  at: string;
  label: string;
}
