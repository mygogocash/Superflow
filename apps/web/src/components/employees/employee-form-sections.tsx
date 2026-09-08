"use client";

import { Dices, Eye, EyeOff, Info } from "lucide-react";
import type { UseFormReturn } from "react-hook-form";

import {
  type EmployeeFormValues,
  generatePassword,
} from "@/components/employees/employee-form-schema";
import { FormDatePicker } from "@/components/shared/form-date-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Entity } from "@/services/entity.service";
import type { RoleListItem } from "@/services/role.service";
import {
  DEPARTMENTS,
  EMPLOYMENT_TYPE_LABELS,
  EMPLOYMENT_TYPES,
} from "@/services/user.service";

export const WORK_PERMIT_TYPES = ["NON-BOI WP", "BOI WP"] as const;

export const VISA_TYPES = [
  "Non-Immigration B (Business - NON-BOI)",
  "Non-Immigration B (Business - BOI)",
  "Non-Immigration IB (Business - BOI)",
  "Visa On Arrival (VOA)/Visa Exemption (30 Days)",
  "Visa On Arrival (VOA)/Visa Exemption (60 Days)",
  "Non-Immigrant TR (Tourist)",
  "Non-Immigrant O (Family/Spouse/Dependent)",
  "Non-Immigration B (Conduct Business/Meeting)",
] as const;

const SECTION_LABEL_CLASS = `text-muted-foreground text-[10px] font-bold tracking-widest uppercase`;

interface SectionProps {
  form: UseFormReturn<EmployeeFormValues>;
}

interface PersonalInfoSectionProps extends SectionProps {
  isEditing: boolean;
}

export function PersonalInfoSection({
  form,
  isEditing,
}: PersonalInfoSectionProps) {
  return (
    <section className="flex flex-col gap-3">
      <p className={SECTION_LABEL_CLASS}>Personal info</p>
      <div className="grid grid-cols-2 gap-3">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem className="col-span-2">
              <FormLabel>Full name *</FormLabel>
              <FormControl>
                <Input placeholder="e.g. James Chen" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email *</FormLabel>
              <FormControl>
                <Input
                  type="email"
                  placeholder="name@tbh.ae"
                  disabled={isEditing}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="phone"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Phone</FormLabel>
              <FormControl>
                <Input placeholder="+971 ..." {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
    </section>
  );
}

interface EmploymentSectionProps extends SectionProps {
  entities: Entity[];
}

export function EmploymentSection({ form, entities }: EmploymentSectionProps) {
  return (
    <section className="flex flex-col gap-3">
      <p className={SECTION_LABEL_CLASS}>Employment</p>
      <div className="grid grid-cols-2 gap-3">
        <FormField
          control={form.control}
          name="entityId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Entity</FormLabel>
              <Select value={field.value || ""} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select entity" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {entities.map((e) => (
                    <SelectItem key={e.id} value={e.id}>
                      {e.name} ({e.code})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="department"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Department *</FormLabel>
              <Select value={field.value || ""} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select department" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {DEPARTMENTS.map((d) => (
                    <SelectItem key={d} value={d}>
                      {d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="jobTitle"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Job title</FormLabel>
              <FormControl>
                <Input placeholder="e.g. Senior Engineer" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="employeeId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Employee ID</FormLabel>
              <FormControl>
                <Input
                  placeholder="MNT-001"
                  {...field}
                  onChange={(e) => field.onChange(e.target.value.toUpperCase())}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="employmentType"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Employment type</FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {EMPLOYMENT_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {EMPLOYMENT_TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="startDate"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Start date</FormLabel>
              <FormControl>
                <FormDatePicker {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="dateOfBirth"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Date of birth</FormLabel>
              <FormControl>
                <FormDatePicker {...field} />
              </FormControl>
              <p className="text-muted-foreground text-[11px]">
                Used as the password for the employee&apos;s payslip downloads
                (DDMMYYYY).
              </p>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="location"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Location</FormLabel>
              <FormControl>
                <Input placeholder="City" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="country"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Country</FormLabel>
              <FormControl>
                <Input placeholder="UAE" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
    </section>
  );
}

export function IdentitySection({ form }: SectionProps) {
  return (
    <section className="flex flex-col gap-3">
      <p className={SECTION_LABEL_CLASS}>Identity</p>
      <div className="grid grid-cols-2 gap-3">
        <FormField
          control={form.control}
          name="passportNumber"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Passport Number</FormLabel>
              <FormControl>
                <Input placeholder="e.g. A12345678" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="thaiId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Thai ID</FormLabel>
              <FormControl>
                <Input placeholder="13-digit Thai ID" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="taxId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Tax ID Number</FormLabel>
              <FormControl>
                <Input placeholder="Tax identification number" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="aadhaarNumber"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Aadhaar No</FormLabel>
              <FormControl>
                <Input placeholder="12-digit Aadhaar number" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="panCardNumber"
          render={({ field }) => (
            <FormItem>
              <FormLabel>PAN Card No</FormLabel>
              <FormControl>
                <Input placeholder="e.g. ABCDE1234F" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
    </section>
  );
}

const REPORTING_TO_NONE = "__reporting_to_none__";

interface ImmigrationSectionProps extends SectionProps {
  employees: Array<{ id: string; name: string }>;
  managersLoading?: boolean;
}

export function ImmigrationSection({
  form,
  employees,
  managersLoading = false,
}: ImmigrationSectionProps) {
  return (
    <section className="flex flex-col gap-3">
      <p className={SECTION_LABEL_CLASS}>Immigration & Reporting</p>
      <div className="grid grid-cols-2 gap-3">
        <FormField
          control={form.control}
          name="workPermitType"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Work Permit Type</FormLabel>
              <Select value={field.value || ""} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {WORK_PERMIT_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="visaType"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Visa / Permit Type</FormLabel>
              <Select value={field.value || ""} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {VISA_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="permitNumber"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Permit Number</FormLabel>
              <FormControl>
                <Input placeholder="Work/visa permit number" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="reportingTo"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Line Manager / Supervisor</FormLabel>
              <Select
                // Force a remount when the candidate set changes so
                // Radix re-evaluates value→item matching. Without this
                // a value bound before items arrived can stick on the
                // placeholder even after the matching SelectItem
                // mounts.
                key={`mgr-${employees.length}`}
                disabled={managersLoading}
                value={field.value ? field.value : REPORTING_TO_NONE}
                onValueChange={(v) =>
                  field.onChange(v === REPORTING_TO_NONE ? "" : v)
                }
              >
                <FormControl>
                  <SelectTrigger className="w-full">
                    <SelectValue
                      placeholder={
                        managersLoading ? "Loading managers…" : "Select manager"
                      }
                    />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value={REPORTING_TO_NONE}>None</SelectItem>
                  {employees.map((e) => (
                    <SelectItem key={e.id} value={e.id}>
                      {e.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
    </section>
  );
}

interface AccountSectionProps extends SectionProps {
  showPassword: boolean;
  setShowPassword: (value: boolean | ((prev: boolean) => boolean)) => void;
}

export function AccountSection({
  form,
  showPassword,
  setShowPassword,
}: AccountSectionProps) {
  return (
    <section className="flex flex-col gap-3">
      <p className={SECTION_LABEL_CLASS}>Account</p>
      <FormField
        control={form.control}
        name="password"
        render={({ field }) => (
          <FormItem>
            <div className="flex items-center justify-between">
              <FormLabel>Initial password *</FormLabel>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => {
                  const pwd = generatePassword();
                  field.onChange(pwd);
                  setShowPassword(true);
                }}
              >
                <Dices className="mr-1 size-3" />
                Generate
              </Button>
            </div>
            <FormControl>
              <div className="relative">
                <Input
                  type={showPassword ? "text" : "password"}
                  placeholder="Min 8 characters"
                  {...field}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className={`absolute top-1/2 right-1 -translate-y-1/2`}
                  onClick={() => setShowPassword((v: boolean) => !v)}
                >
                  {showPassword ? (
                    <EyeOff className="size-3.5" />
                  ) : (
                    <Eye className="size-3.5" />
                  )}
                </Button>
              </div>
            </FormControl>
            <p className="text-muted-foreground text-[11px]">
              Employee will be required to change this on first login.
            </p>
            <FormMessage />
          </FormItem>
        )}
      />
    </section>
  );
}

interface RolesSectionProps extends SectionProps {
  roles: RoleListItem[];
  employeeRole: RoleListItem | undefined;
}

export function RolesSection({ form, roles, employeeRole }: RolesSectionProps) {
  return (
    <section className="flex flex-col gap-3">
      <p className={SECTION_LABEL_CLASS}>Roles</p>
      <FormField
        control={form.control}
        name="roleIds"
        render={() => (
          <FormItem>
            <FormLabel>Roles *</FormLabel>
            <div className="grid grid-cols-2 gap-2">
              {roles.map((role) => {
                return (
                  <FormField
                    key={role.id}
                    control={form.control}
                    name="roleIds"
                    render={({ field }) => {
                      const isBaselineEmployeeRole =
                        employeeRole !== undefined &&
                        role.id === employeeRole.id;
                      const checked = isBaselineEmployeeRole
                        ? true
                        : (field.value?.includes(role.id) ?? false);
                      const employeeRoleLocked = isBaselineEmployeeRole;

                      return (
                        <FormItem className="flex items-center gap-2 space-y-0">
                          <FormControl>
                            <Checkbox
                              checked={checked}
                              disabled={employeeRoleLocked}
                              onCheckedChange={(val) => {
                                if (employeeRoleLocked) return;
                                const current = field.value ?? [];
                                field.onChange(
                                  val
                                    ? [...current, role.id]
                                    : current.filter((id) => id !== role.id),
                                );
                              }}
                            />
                          </FormControl>
                          <FormLabel
                            className={`
                              flex items-center gap-1 text-sm font-normal
                            `}
                          >
                            {role.name}
                            {employeeRoleLocked && (
                              <Badge
                                variant="outline"
                                className="ml-1 text-[10px]"
                              >
                                Required
                              </Badge>
                            )}
                            {role.description && (
                              <TooltipProvider delayDuration={200}>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Info
                                      className={`
                                        text-muted-foreground h-3.5 w-3.5
                                        cursor-help
                                      `}
                                    />
                                  </TooltipTrigger>
                                  <TooltipContent
                                    side="right"
                                    className="max-w-64"
                                  >
                                    <p className="text-xs">
                                      {role.description}
                                    </p>
                                    {role.permissionCount > 0 && (
                                      <p
                                        className={`
                                          text-muted-foreground mt-1 text-[10px]
                                        `}
                                      >
                                        {role.permissionCount} permission
                                        {role.permissionCount !== 1 && "s"}
                                      </p>
                                    )}
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            )}
                          </FormLabel>
                        </FormItem>
                      );
                    }}
                  />
                );
              })}
            </div>
            {roles.length === 0 && (
              <p className="text-muted-foreground text-sm">
                No roles available.
              </p>
            )}
            <FormMessage />
          </FormItem>
        )}
      />
    </section>
  );
}
