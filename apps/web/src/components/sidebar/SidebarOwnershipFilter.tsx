import { useAtomValue } from "@effect/atom-react";
import { isOwnershipRelation } from "@t3tools/client-runtime/state/identity";
import { T, useGT } from "gt-react";
import { UserRoundIcon, UsersRoundIcon } from "lucide-react";

import { identityEnabledEnvironmentIdsAtom } from "../../state/identity";
import {
  SIDEBAR_OWNERSHIP_FILTERS,
  SIDEBAR_OWNERSHIP_RELATIONS,
  useOwnershipFilter,
  type SidebarOwnershipFilter,
} from "../ownershipFilter";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";

function isOwnershipFilter(value: unknown): value is SidebarOwnershipFilter {
  return SIDEBAR_OWNERSHIP_FILTERS.some((mode) => mode === value);
}

/** Mine / theirs thread filter; shown only while an environment has an identity map. */
export function SidebarOwnershipFilter() {
  const gt = useGT();
  const enabled = useAtomValue(identityEnabledEnvironmentIdsAtom);
  const { mode, relation, setMode, setRelation } = useOwnershipFilter();
  if (enabled.size === 0) return null;
  const modeLabels: Record<SidebarOwnershipFilter, string> = {
    any: gt("Anyone"),
    mine: gt("Mine + unattributed"),
    "mine-only": gt("Only mine"),
    theirs: gt("Theirs"),
  };
  const relationLabels: Record<(typeof SIDEBAR_OWNERSHIP_RELATIONS)[number], string> = {
    both: gt("Created or participated"),
    created: gt("Created"),
    participated: gt("Participated"),
  };
  return (
    <Menu>
      <MenuTrigger
        render={
          <SidebarHeaderIconButton
            label={gt("Filter threads by owner: {owner}", { owner: modeLabels[mode] })}
            data-testid="sidebar-ownership-filter"
          />
        }
      >
        {mode === "any" ? (
          <UsersRoundIcon className="size-4" />
        ) : (
          <UserRoundIcon className="size-4" />
        )}
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuGroup>
          <MenuGroupLabel>
            <T>Owner</T>
          </MenuGroupLabel>
          <MenuRadioGroup
            value={mode}
            onValueChange={(value) => {
              if (isOwnershipFilter(value)) setMode(value);
            }}
          >
            {SIDEBAR_OWNERSHIP_FILTERS.map((value) => (
              <MenuRadioItem key={value} value={value} closeOnClick>
                {modeLabels[value]}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        {mode === "any" ? null : (
          <>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>
                <T>Role</T>
              </MenuGroupLabel>
              <MenuRadioGroup
                value={relation}
                onValueChange={(value) => {
                  if (isOwnershipRelation(value)) setRelation(value);
                }}
              >
                {SIDEBAR_OWNERSHIP_RELATIONS.map((value) => (
                  <MenuRadioItem key={value} value={value} closeOnClick>
                    {relationLabels[value]}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          </>
        )}
      </MenuPopup>
    </Menu>
  );
}
