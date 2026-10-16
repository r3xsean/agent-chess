import "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      piece: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
    }
  }
}
