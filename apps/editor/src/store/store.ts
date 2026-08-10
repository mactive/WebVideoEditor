import { configureStore } from "@reduxjs/toolkit";
import {
  assertValidProjectDocument,
  type ProjectDocument,
} from "@web-video-editor/domain";

import { projectReducer } from "./projectSlice";
import { sessionReducer } from "./sessionSlice";

export function createEditorStore(project?: ProjectDocument) {
  if (project) {
    assertValidProjectDocument(project);
  }
  return configureStore({
    reducer: {
      project: projectReducer,
      session: sessionReducer,
    },
    preloadedState: project
      ? {
          project: { document: project },
        }
      : undefined,
  });
}

export type EditorStore = ReturnType<typeof createEditorStore>;
export type RootState = ReturnType<EditorStore["getState"]>;
export type AppDispatch = EditorStore["dispatch"];
