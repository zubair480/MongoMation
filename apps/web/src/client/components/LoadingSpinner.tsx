import { Spinner } from '@/client/components/ui/Spinner';

interface LoadingSpinnerProps {
  fullScreen?: boolean;
  message?: string;
}

/**
 * Page-level loading state (centered container, optional full-screen + message).
 * For an inline spinner inside a control (e.g. a button), use
 * `components/ui/Spinner` instead.
 */
export default function LoadingSpinner({ fullScreen = false, message }: LoadingSpinnerProps) {
  const containerClasses = fullScreen
    ? "h-screen flex items-center justify-center bg-plant-950"
    : "flex items-center justify-center min-h-screen";

  return (
    <div className={containerClasses}>
      <div className="flex flex-col items-center gap-4">
        <Spinner className="size-8 text-flow-400" />
        {message && <p className="text-plant-300 text-sm">{message}</p>}
      </div>
    </div>
  );
}
