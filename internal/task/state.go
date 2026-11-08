package task

// Task states:
//
//	created -> queued -> running -> completed / failed / cancelled
//	                         ├─ waiting_approval -> running
//	                         ├─ waiting_input    -> running
//	                         └─ paused           -> running
func CanTransitionTask(from, to Status) bool {
	switch from {
	case StatusCreated:
		return to == StatusQueued || to == StatusRunning || to == StatusCancelled
	case StatusQueued:
		return to == StatusRunning || to == StatusCancelled || to == StatusFailed
	case StatusRunning:
		return to == StatusWaitingApproval || to == StatusWaitingInput ||
			to == StatusPaused || to == StatusCompleted || to == StatusFailed || to == StatusCancelled
	case StatusWaitingApproval, StatusWaitingInput:
		return to == StatusRunning || to == StatusFailed || to == StatusCancelled
	case StatusPaused:
		return to == StatusRunning || to == StatusCancelled
	default:
		return false
	}
}

// Run states:
//
//	queued -> running -> completed / failed / cancelled
//	              └─ waiting_approval / waiting_input -> running
func CanTransitionRun(from, to Status) bool {
	switch from {
	case StatusQueued:
		return to == StatusRunning || to == StatusFailed || to == StatusCancelled
	case StatusRunning:
		return to == StatusWaitingApproval || to == StatusWaitingInput ||
			to == StatusCompleted || to == StatusFailed || to == StatusCancelled
	case StatusWaitingApproval, StatusWaitingInput:
		return to == StatusRunning || to == StatusFailed || to == StatusCancelled
	default:
		return false
	}
}

func IsTerminal(status Status) bool {
	return status == StatusCompleted || status == StatusFailed || status == StatusCancelled
}
