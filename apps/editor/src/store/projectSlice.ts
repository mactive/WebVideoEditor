import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import {
  assertValidProjectDocument,
  createProjectDocument,
  type ProjectDocument,
} from "@web-video-editor/domain";

export type ProjectState = {
  document: ProjectDocument;
};

const initialState: ProjectState = {
  document: createProjectDocument({
    id: "local-project",
    name: "未命名工程",
  }),
};

const projectSlice = createSlice({
  name: "project",
  initialState,
  reducers: {
    projectCommitted(state, action: PayloadAction<ProjectDocument>) {
      assertValidProjectDocument(action.payload);
      state.document = action.payload;
    },
    projectRestored(state, action: PayloadAction<ProjectDocument>) {
      assertValidProjectDocument(action.payload);
      state.document = action.payload;
    },
  },
});

export const { projectCommitted, projectRestored } = projectSlice.actions;
export const projectReducer = projectSlice.reducer;
