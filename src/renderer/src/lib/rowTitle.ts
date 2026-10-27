/** A sidebar row's tooltip: its full name (a narrow sidebar cuts it short), then what else there is to say. */
export const rowTitle = (name: string, more?: string): string => (more ? `${name}\n${more}` : name)
