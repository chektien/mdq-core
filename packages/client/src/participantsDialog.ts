/** Native dialog lifetime, shared by each mounted Participants dialog node. */
export function mountParticipantsDialog(
  dialog: {
    readonly isConnected: boolean;
    readonly open: boolean;
    showModal: () => void;
    close: () => void;
  },
  opener: {
    readonly isConnected: boolean;
    focus: (options?: { preventScroll?: boolean }) => void;
  } | null,
): () => void {
  // Ref callbacks run after insertion. Guard repeated setup and detached nodes.
  if (dialog.isConnected && !dialog.open) dialog.showModal();
  return () => {
    if (dialog.open) dialog.close();
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  };
}
