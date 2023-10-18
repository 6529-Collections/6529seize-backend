export interface ErrorResponse {
  error: string;
}

export type ApiResponse<T> = T | ErrorResponse;

export const INTERNAL_SERVER_ERROR: ErrorResponse = {
  error: 'Something went wrong'
};
