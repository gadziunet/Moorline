// A stack name is also its folder name in the stacks folder and its Docker Compose project name:
// lower-case letters, digits, "-" and "_", starting with a letter or digit – never a path.
export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
