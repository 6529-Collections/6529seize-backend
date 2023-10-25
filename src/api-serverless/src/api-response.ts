export interface ErrorResponse {
  error: string;
}

export type ApiResponse<T> = T | ErrorResponse;
