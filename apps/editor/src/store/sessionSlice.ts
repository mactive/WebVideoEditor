import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

export type PersistenceStatus =
  "error" | "idle" | "loading" | "saved" | "saving";

export type EditorSessionState = {
  playheadUs: number;
  playing: boolean;
  selectedClipId: string | null;
  selectedTextId: string | null;
  targetAudioTrackId: string | null;
  targetVideoTrackId: string | null;
  persistenceStatus: PersistenceStatus;
  persistenceError: string | null;
  lastSavedAt: string | null;
};

const initialState: EditorSessionState = {
  playheadUs: 0,
  playing: false,
  selectedClipId: null,
  selectedTextId: null,
  targetAudioTrackId: null,
  targetVideoTrackId: null,
  persistenceStatus: "idle",
  persistenceError: null,
  lastSavedAt: null,
};

const sessionSlice = createSlice({
  name: "session",
  initialState,
  reducers: {
    playheadChanged(state, action: PayloadAction<number>) {
      state.playheadUs = action.payload;
    },
    playbackChanged(state, action: PayloadAction<boolean>) {
      state.playing = action.payload;
    },
    clipSelected(state, action: PayloadAction<string | null>) {
      state.selectedClipId = action.payload;
      state.selectedTextId = null;
    },
    textSelected(state, action: PayloadAction<string | null>) {
      state.selectedTextId = action.payload;
      state.selectedClipId = null;
    },
    targetAudioTrackSelected(state, action: PayloadAction<string | null>) {
      state.targetAudioTrackId = action.payload;
    },
    targetVideoTrackSelected(state, action: PayloadAction<string | null>) {
      state.targetVideoTrackId = action.payload;
    },
    persistenceLoading(state) {
      state.persistenceStatus = "loading";
      state.persistenceError = null;
    },
    persistenceSaving(state) {
      state.persistenceStatus = "saving";
      state.persistenceError = null;
    },
    persistenceSaved(state, action: PayloadAction<string>) {
      state.persistenceStatus = "saved";
      state.persistenceError = null;
      state.lastSavedAt = action.payload;
    },
    persistenceFailed(state, action: PayloadAction<string>) {
      state.persistenceStatus = "error";
      state.persistenceError = action.payload;
    },
  },
});

export const {
  clipSelected,
  persistenceFailed,
  persistenceLoading,
  persistenceSaved,
  persistenceSaving,
  playbackChanged,
  playheadChanged,
  targetAudioTrackSelected,
  targetVideoTrackSelected,
  textSelected,
} = sessionSlice.actions;
export const sessionReducer = sessionSlice.reducer;
