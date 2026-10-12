// app/components/AppSelect.tsx
//
// A drop-in for Polaris's <Select> whose list is drawn by the app, not by the
// browser.
//
// Polaris's Select is a native <select>, so its option list is the browser's
// own popup. On some machines that popup's window comes out larger than its
// list, as a white box covering the page behind it, and nothing in the page
// can restyle it. This keeps the field looking exactly the same closed, and
// opens a Polaris Popover with the options instead.
//
// Closed, it is Polaris's own select markup with one change: the invisible
// <select> is a <button>. It leans on Polaris 12's select class names for the
// look (hover, focus ring, disabled, the corners of joined fields), so check
// it against Select.js if Polaris is ever moved to a new major version.

import { useId, useRef, useState, type ReactNode, type SVGProps } from "react";
import { Box, Icon, Labelled, OptionList, Popover, Text } from "@shopify/polaris";

export interface SelectOption {
  label: string;
  value: string;
  disabled?: boolean;
}

export interface SelectProps {
  label: ReactNode;
  /** Visually hide the label. */
  labelHidden?: boolean;
  /** Show the label inside the field, before the value. */
  labelInline?: boolean;
  options: ReadonlyArray<SelectOption>;
  value?: string;
  onChange?: (selected: string, id: string) => void;
  helpText?: ReactNode;
  disabled?: boolean;
}

/** About eight options; a longer list scrolls. */
const LIST_MAX_HEIGHT = 288;

/** Polaris's select chevrons (polaris-icons SelectIcon), which the app doesn't depend on directly. */
function SelectChevrons(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" {...props}>
      <path d="M10.884 4.323a1.25 1.25 0 0 0-1.768 0l-2.646 2.647a.75.75 0 0 0 1.06 1.06l2.47-2.47 2.47 2.47a.75.75 0 1 0 1.06-1.06l-2.646-2.647Z" />
      <path d="m13.53 13.03-2.646 2.647a1.25 1.25 0 0 1-1.768 0l-2.646-2.647a.75.75 0 0 1 1.06-1.06l2.47 2.47 2.47-2.47a.75.75 0 0 1 1.06 1.06Z" />
    </svg>
  );
}

export function Select({
  label,
  labelHidden,
  labelInline,
  options,
  value = "",
  onChange,
  helpText,
  disabled,
}: SelectProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const fieldRef = useRef<HTMLDivElement>(null);
  // The field's width when it was opened: the list is never narrower than it.
  const [fieldWidth, setFieldWidth] = useState(0);

  // Like a native select: an unknown value shows the first option.
  const current = options.find((o) => o.value === value) ?? options[0];

  const toggle = () => {
    if (!open) setFieldWidth(fieldRef.current?.offsetWidth ?? 0);
    setOpen(!open);
  };

  const field = (
    <div ref={fieldRef} className={`Polaris-Select${disabled ? " Polaris-Select--disabled" : ""}`}>
      <button
        type="button"
        id={id}
        className="Polaris-Select__Input"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={toggle}
      />
      <div className="Polaris-Select__Content" aria-hidden aria-disabled={disabled}>
        {labelInline && (
          <Box paddingInlineEnd="100">
            <Text as="span" variant="bodyMd" tone="subdued" truncate>{label}</Text>
          </Box>
        )}
        <span className="Polaris-Select__SelectedOption">{current?.label ?? ""}</span>
        <span className="Polaris-Select__Icon">
          <Icon source={SelectChevrons} />
        </span>
      </div>
      <div className="Polaris-Select__Backdrop" />
    </div>
  );

  return (
    <Labelled
      id={id}
      label={label}
      labelHidden={labelInline ? true : labelHidden}
      helpText={helpText}
      disabled={disabled}
    >
      <Popover
        active={open && !disabled}
        activator={field}
        onClose={() => setOpen(false)}
        // Sized by the list below, not by Polaris: as wide as the field, wider
        // if an option needs it (a narrow field would wrap its options).
        fluidContent
        preferredAlignment="left"
        autofocusTarget="first-node"
      >
        {/* A long list scrolls rather than covering the window it opened from. */}
        <div style={{ minWidth: fieldWidth, maxHeight: LIST_MAX_HEIGHT, overflowY: "auto" }}>
          <OptionList
            role="listbox"
            options={options.map((o) => ({ label: o.label, value: o.value, disabled: o.disabled }))}
            selected={current ? [current.value] : []}
            onChange={([picked]) => {
              setOpen(false);
              if (picked !== undefined && picked !== value) onChange?.(picked, id);
            }}
          />
        </div>
      </Popover>
    </Labelled>
  );
}
