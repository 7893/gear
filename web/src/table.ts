export type TableColumn<T> = {
  key: string;
  label: string;
  value?: (row: T) => string | number | null | undefined;
};
