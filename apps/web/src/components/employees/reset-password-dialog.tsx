"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Dices, Eye, EyeOff, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api-client";
import { resetUserPassword, type UserListItem } from "@/services/user.service";

const resetPasswordSchema = z.object({
  password: z.string().min(8, "Password must be at least 8 characters"),
});

type ResetPasswordValues = z.infer<typeof resetPasswordSchema>;

function generatePassword(): string {
  const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%";
  // Rejection sampling avoids the modulo bias of `b % chars.length`.
  const max = Math.floor(256 / chars.length) * chars.length;
  let out = "";
  while (out.length < 14) {
    for (const b of crypto.getRandomValues(new Uint8Array(14))) {
      if (b < max) {
        out += chars[b % chars.length];
        if (out.length === 14) break;
      }
    }
  }
  return out;
}

interface ResetPasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: UserListItem | null;
}

export function ResetPasswordDialog({
  open,
  onOpenChange,
  user,
}: ResetPasswordDialogProps) {
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<ResetPasswordValues>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { password: "" },
  });

  useEffect(() => {
    if (open) {
      form.reset({ password: "" });
      setShowPassword(false);
    }
  }, [open, form]);

  async function onSubmit(values: ResetPasswordValues) {
    if (!user) return;
    try {
      setSubmitting(true);
      await resetUserPassword(user.id, values.password);
      toast.success(`Password reset for ${user.name}`);
      onOpenChange(false);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Failed to reset password";
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!submitting) onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset password</DialogTitle>
          <DialogDescription>
            Set a new password for{" "}
            <span className="text-foreground font-medium">
              {user?.name ?? "user"}
            </span>
            . The user will be required to change it on next login.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex flex-col gap-4"
            id="reset-password-form"
          >
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <div className="flex items-center justify-between">
                    <FormLabel>New password</FormLabel>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => {
                        const pw = generatePassword();
                        form.setValue("password", pw, { shouldValidate: true });
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
                        {...field}
                        type={showPassword ? "text" : "password"}
                        placeholder="Min 8 characters"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="absolute top-1/2 right-1 -translate-y-1/2"
                        onClick={() => setShowPassword((v) => !v)}
                      >
                        {showPassword ? (
                          <EyeOff className="size-3.5" />
                        ) : (
                          <Eye className="size-3.5" />
                        )}
                      </Button>
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </form>
        </Form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form="reset-password-form"
            disabled={submitting}
            className="min-w-32"
          >
            {submitting && <Loader2 className="mr-2 size-3.5 animate-spin" />}
            Reset password
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
